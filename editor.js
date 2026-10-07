"use strict";
/* ============================================================================
 * editor — the Editor tab.
 *
 *   State   the preset being edited (a P2KC preset object), the copy it was
 *           loaded as, where it came from, and an undo stack.
 *   Sync    talks to the P2K. Get = edit-buffer dump (closed loop, ACK per
 *           packet); Send/Write = preset dump to the edit buffer or a user
 *           location; every control change goes out live as a parameter edit
 *           (LAYER_SELECT first when the layer changes), paced and coalesced.
 *   View    pages built from layout code; each control registers an update()
 *           so a load or an undo repaints everything in one pass.
 *
 * Hardware facts this relies on (prodatum / Edisyn, see README):
 *   - the SysEx edit buffer belongs to the unit's basic channel;
 *   - after a dump, the unit ignores live edits until the channel's multimode
 *     ROM id (param 138) is set to 0 and PRESET_SELECT (897) to the edit buffer;
 *   - parameter edits only affect notes played after them.
 * ==========================================================================*/
const Editor = (() => {
  const $ = (id) => document.getElementById(id);
  const D = P2KD, C = P2KC, P = P2KD.PARAMS;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const LAYER_COLORS = ["#6ea8ff", "#6bd49a", "#e8b85a", "#e07ad8"];
  const ID = { MM_CHANNEL: 129, MM_ROM: 138, BASIC_CHANNEL: 139, PRESET_SELECT: 897, LAYER_SELECT: 898, NAME: 899 };

  const { el, svg, card, cells, sub, fillSelect } = UI;

  /* ============================== state ================================== */
  const S = {
    preset: null,
    pristine: null,     // as loaded; Revert goes back here
    origin: null,       // { kind: "unit" | "file" | "init", romId, number }
    page: "preset",     // "preset" or a layer index 0..3
    live: false,        // the P2K's edit buffer holds this preset; edits go out as they happen
    dirty: false,
    busy: null,         // "get" | "send" | "write" while talking to the unit (one at a time)
    version: 0,         // bumped on every change, so a transfer can tell it missed some
    stale: null,        // a preset selected on the unit after we loaded: { romId, number, name }
    selections: 0,      // program changes sent from the Presets tab so far
    loadedSelections: 0,// ... as of the last Get/Send/Write
    lastSelect: 0,      // when the Presets tab last sent a program change
    lastSelected: null, // what it sent: { romId, number, name }
  };
  let undoStack = [], redoStack = [];
  let preparedChannel = null;  // channel the unit's basic channel was confirmed for

  const initPreset = () => C.presetsFromSysex(C.fromHex(D.INIT_SYX))[0].preset;

  const isLayer = (id) => id >= 1408;
  const curLayer = () => (typeof S.page === "number" ? S.page : 0);
  const scope = (id, layer = curLayer()) => (isLayer(id) ? S.preset.layers[layer] : S.preset.common);
  const get = (id, layer) => { const s = scope(id, layer); return s ? s[id] : undefined; };

  function markDirty() { S.dirty = true; S.version++; paintBar(); }

  // A Get is about to replace the preset: edits made meanwhile would be thrown away.
  function refuseWhileGetting() {
    if (S.busy !== "get") return false;
    setStatus("Wait a moment: the P2K is still sending its preset.");
    scheduleRepaint();
    return true;
  }

  // Edits go out live, except during a dump: Send and Write notice the change
  // (S.version) and send the whole preset again afterwards.
  const canSendLive = () => S.live && !S.busy;

  function setParam(id, v, { layer = curLayer(), record = true } = {}) {
    if (refuseWhileGetting()) return false;
    const s = scope(id, layer);
    if (!s) return false;
    const d = P[id];
    v = Math.round(v);
    if (d) v = clamp(v, d.min, d.max);
    const old = s[id];
    if (old === v) return true;
    s[id] = v;
    if (record) pushUndo({ kind: "param", id, layer: isLayer(id) ? layer : -1, from: old, to: v });
    markDirty();
    if (canSendLive()) sendParam(id, v, layer);
    scheduleRepaint();
    return true;
  }

  // Names are 16 printable ASCII chars: "cat:Name".
  const cleanName = (s) => s.replace(/[^\x20-\x7e]/g, " ").padEnd(16).slice(0, 16);

  function setName(name, record = true) {
    if (refuseWhileGetting()) return false;
    name = cleanName(name);
    const old = S.preset.name;
    if (old === name) return true;
    S.preset.name = name;
    if (record) pushUndo({ kind: "name", from: old, to: name });
    markDirty();
    if (canSendLive()) {
      for (let i = 0; i < 16; i++) {
        if (old[i] === name[i]) continue;
        const c = name.charCodeAt(i);
        Midi.enqueue(() => [C.paramEdit(Midi.devId, [[ID.NAME + i, c]])], { key: "n" + i, gap: 20 });
      }
    }
    scheduleRepaint();
    return true;
  }

  // Replace the whole preset (init, revert, file, copy layer): one undo step, one dump.
  // Not while talking to the unit: that would race the transfer.
  function replacePreset(p, { origin, record = true, send = S.live } = {}) {
    if (S.busy) {
      setStatus("Wait a moment: the editor is still talking to the P2K.");
      scheduleRepaint();
      return false;
    }
    const before = C.clonePreset(S.preset);
    S.preset = p;
    if (origin) S.origin = origin;
    if (record) pushUndo({ kind: "bulk", from: before, to: C.clonePreset(p) });
    markDirty();
    scheduleRepaint(true);
    if (send) sendToUnit();
    return true;
  }

  /* ------------------------------ undo ----------------------------------- */
  function pushUndo(e) {
    e.t = performance.now();
    const top = undoStack[undoStack.length - 1];
    // A slider drag or a typed name is one step.
    if (top && top.kind === e.kind && e.kind !== "bulk" && top.id === e.id && top.layer === e.layer && e.t - top.t < 1200) {
      top.to = e.to; top.t = e.t;
    } else {
      undoStack.push(e);
      if (undoStack.length > 300) undoStack.shift();
    }
    redoStack = [];
    paintBar();
  }

  // Returns false when the step couldn't be applied (the editor is busy).
  function apply(e, which) {
    if (e.kind === "param") {
      if (e.layer >= 0 && S.page !== e.layer && S.page !== "preset") showPage(e.layer);
      return setParam(e.id, e[which], { layer: e.layer >= 0 ? e.layer : curLayer(), record: false });
    }
    if (e.kind === "name") return setName(e[which], false);
    return replacePreset(C.clonePreset(e[which]), { record: false });
  }
  function undo() {
    const e = undoStack[undoStack.length - 1];
    if (!e || !apply(e, "from")) return;
    redoStack.push(undoStack.pop());
    paintBar();
  }
  function redo() {
    const e = redoStack[redoStack.length - 1];
    if (!e || !apply(e, "to")) return;
    undoStack.push(redoStack.pop());
    paintBar();
  }

  /* ============================== sync =================================== */
  function sendParam(id, v, layer) {
    const key = "p" + (isLayer(id) ? layer : "c") + ":" + id;
    Midi.enqueue(() => {
      // The Setup tab may have moved the channel or layer selection: put them back first.
      const msgs = Midi.select(ID.MM_CHANNEL, Midi.channel);
      if (isLayer(id)) msgs.push(...Midi.select(ID.LAYER_SELECT, layer));
      msgs.push(C.paramEdit(Midi.devId, [[id, v]]));
      return msgs;
    }, { key, gap: 20 });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sameName = (a, b) => {
    const norm = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
    a = norm(a); b = norm(b);
    return !!a && !!b && (a.startsWith(b) || b.startsWith(a));   // manual names can be truncated
  };

  // SysEx access plus both ports; explains what's missing.
  async function ready(needInput) {
    if (!(await Midi.enableSysex())) return false;
    if (!Midi.output) {
      setStatus("Pick the MIDI output that goes to the P2K's MIDI In.", "err");
      return false;
    }
    if (needInput && !Midi.input) {
      setStatus("Pick the MIDI input that comes from the P2K's MIDI Out: the editor reads presets through it.", "err");
      return false;
    }
    return true;
  }

  // The SysEx edit buffer is the basic channel's preset (prodatum sets the
  // basic channel to the editing channel). Only touch it when it differs, and
  // only count it as done once the unit has answered.
  async function prepareChannel() {
    const ch = Midi.channel, dev = Midi.devId;
    Midi.sendNow(C.paramEdit(dev, [[ID.MM_CHANNEL, ch]]));
    Midi.selectedAs(ID.MM_CHANNEL, ch);
    if (preparedChannel === ch || !Midi.input) return "";
    let note = "";
    try {
      const answer = Midi.waitFor((m) => m.type === "param" && m.params.some((p) => p[0] === ID.BASIC_CHANNEL), 700);
      Midi.sendNow(C.paramRequest(dev, [ID.BASIC_CHANNEL]));
      const basic = (await answer).params.find((p) => p[0] === ID.BASIC_CHANNEL)[1];
      if (basic !== ch) {
        Midi.sendNow(C.paramEdit(dev, [[ID.BASIC_CHANNEL, ch]]));
        note = " Set the P2K's basic channel from " + (basic + 1) + " to " + (ch + 1) + " so its edit buffer is this channel's preset.";
      }
      preparedChannel = ch;
    } catch { /* no answer: a dump request will report it */ }
    await sleep(30);
    return note;
  }

  // Point the unit's SysEx editing at the edit buffer (and make it take live edits).
  // The layer selection is forgotten when the last message actually goes out.
  function startSession() {
    const ch = Midi.channel;
    Midi.enqueue(() => {
      Midi.selectedAs(ID.MM_CHANNEL, ch);
      return [C.paramEdit(Midi.devId, [[ID.MM_CHANNEL, ch]])];
    }, { gap: 25 });
    Midi.enqueue(() => [C.paramEdit(Midi.devId, [[ID.MM_ROM, 0]])], { gap: 25 });
    Midi.enqueue(() => {
      Midi.forgetSelection(ID.LAYER_SELECT);
      return [C.paramEdit(Midi.devId, [[ID.PRESET_SELECT, C.EDIT_BUFFER]])];
    }, { gap: 25 });
    S.live = true;
    S.stale = null;
    S.loadedSelections = S.selections;
  }

  // Did the unit move on (preset picked in the Presets tab, channel changed) while we talked to it?
  const snapshotUnit = () => ({ selections: S.selections, channel: Midi.channel });
  const unitMoved = (snap) => S.selections !== snap.selections || Midi.channel !== snap.channel;

  // Requests a preset dump (closed loop) and acknowledges each packet.
  function fetchDump(number, romId) {
    return new Promise((resolve, reject) => {
      const dev = Midi.devId, asm = C.PresetAssembler();
      let timer = null;
      const fail = (msg) => {
        off(); clearTimeout(timer);
        if (asm.busy) Midi.sendNow(C.cancel(dev));
        reject(new Error(msg));
      };
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(asm.busy
          ? "The preset dump from the P2K stopped halfway."
          : "No answer from the P2K. Check the MIDI input (from the P2K's MIDI Out) and that the SysEx ID matches the unit's (Master menu)."), ms);
      };
      const off = Midi.listen((m) => {
        if (m.type === "error" && m.cmd === C.CMD.PRESET_DUMP_REQ) { fail("The P2K refused the preset dump request."); return; }
        let r;
        try { r = asm.feed(m); } catch (e) { fail(e.message); return; }
        if (!r) return;
        arm(4000);
        if (r.ack !== undefined) Midi.sendNow(C.ack(dev, r.ack));
        if (r.nak !== undefined) Midi.sendNow(C.nak(dev, r.nak));
        if (r.done) { off(); clearTimeout(timer); resolve(r); }
      });
      arm(3000);
      Midi.sendNow(C.presetDumpRequest(dev, number, romId, true));
    });
  }

  // Sends a preset dump to the edit buffer (-1) or a user location. Closed loop
  // (wait for each ACK) when there is an input; open loop with 150 ms gaps
  // otherwise or if the unit doesn't acknowledge the header.
  async function uploadDump(preset, number) {
    const dev = Midi.devId;
    await Midi.idle();
    const isHandshake = (m) => m.type === "ack" || m.type === "nak" || m.type === "cancel" || m.type === "wait";
    if (Midi.input) {
      const msgs = C.encodePreset(preset, { dev, number, romId: 0, closed: true });
      let i = 0, naks = 0;
      while (i < msgs.length) {
        const answer = Midi.waitFor(isHandshake, i === 0 ? 1500 : 3000, "dump handshake");
        Midi.sendNow(msgs[i]);
        let m;
        try {
          m = await answer;
          while (m.type === "wait") m = await Midi.waitFor(isHandshake, 15000, "dump handshake");
        } catch (e) {
          Midi.sendNow(C.cancel(dev));
          if (i === 0) return openLoop();
          throw new Error("The P2K stopped acknowledging the preset dump.");
        }
        if (m.type === "cancel") throw new Error("The P2K cancelled the preset dump.");
        if (m.type === "nak") {
          if (++naks > 3) { Midi.sendNow(C.cancel(dev)); throw new Error("The P2K rejected a dump packet three times."); }
          continue;
        }
        naks = 0;
        i++;
      }
      Midi.sendNow(C.eof(dev));
      return;
    }
    return openLoop();

    async function openLoop() {
      for (const m of C.encodePreset(preset, { dev, number, romId: 0, closed: false })) {
        Midi.enqueue([m], { gap: 150 });
      }
      await Midi.idle();
    }
  }

  // The name of a user preset, from the cache or (briefly) from the unit.
  async function userName(number) {
    if (UserNames.get(number)) return UserNames.get(number);
    try {
      const answer = Midi.waitFor((m) => m.type === "name" && m.objType === C.OBJ.PRESET, 700);
      Midi.sendNow(C.nameRequest(Midi.devId, C.OBJ.PRESET, number, 0));
      const name = (await answer).name;
      UserNames.set(number, name);
      return name;
    } catch { return ""; }
  }

  // A dump doesn't say which preset it is. Work it out, or leave it unknown:
  //  - picked in the Presets tab since the last load: that one, if the name agrees;
  //  - nothing picked since: still the preset we had, if the name agrees.
  async function originOf(dumped) {
    if (S.selections !== S.loadedSelections && S.lastSelected) {
      const src = S.lastSelected;
      const known = src.romId === 0 ? await userName(src.number) : D.presetName(src.romId, src.number);
      if (sameName(known, dumped.name)) return { kind: "unit", romId: src.romId, number: src.number };
    } else if (S.origin && S.origin.kind === "unit" && S.origin.romId !== null && S.preset && sameName(S.preset.name, dumped.name)) {
      return S.origin;
    }
    return { kind: "unit", romId: null, number: null };
  }

  async function getFromUnit({ force = false } = {}) {
    if (S.busy) return;
    if (S.dirty && S.preset && !force) {
      const what = S.stale ? presetText(S.stale.romId, S.stale.number, S.stale.name) : "the P2K's current preset";
      const ok = await ask("Your edits to " + nameText() + " haven't been written. Load " + what + " and lose them?",
        [["Load and discard edits", true], ["Keep editing", false]]);
      if (ok === undefined || S.busy) return;      // replaced by another prompt, or dismissed
      if (!ok) { if (S.stale) keepEditing(); return; }
    }
    S.busy = "get";
    paintBar();
    try {
      if (!(await ready(true))) return;
      const snap = snapshotUnit();
      // Give the unit a moment after a program change before asking for its edit buffer.
      const since = performance.now() - S.lastSelect;
      if (since < 300) await sleep(300 - since);
      const note = await prepareChannel();
      setStatus("Reading the preset on channel " + (Midi.channel + 1) + " from the P2K…");
      const r = await fetchDump(C.EDIT_BUFFER, 0);
      const origin = await originOf(r.preset);
      S.preset = r.preset;
      S.pristine = C.clonePreset(r.preset);
      S.origin = origin;
      S.dirty = false;
      S.version++;
      undoStack = []; redoStack = [];
      scheduleRepaint(true);
      if (unitMoved(snap)) {
        S.live = false;
        setStatus("Got " + nameText() + ", but the P2K changed preset or channel meanwhile: Get again to follow it.");
      } else {
        hideBanner();
        startSession();
        setStatus("Got " + nameText() + " from the P2K (ch " + (Midi.channel + 1) + "). Edits are sent as you make them." + note, "ok");
      }
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      S.busy = null;
      paintBar();
    }
  }

  async function sendToUnit() {
    if (S.busy || !S.preset) return;     // a running Send/Write re-sends what changed
    S.busy = "send";
    paintBar();
    try {
      if (!(await ready(false))) return;
      const snap = snapshotUnit();
      await prepareChannel();
      let version;
      do {   // edited during the transfer: send again
        version = S.version;
        setStatus("Sending " + nameText() + " to the P2K's edit buffer…");
        await uploadDump(C.clonePreset(S.preset), C.EDIT_BUFFER);
      } while (S.version !== version);
      if (unitMoved(snap)) {
        S.live = false;
        setStatus("Sent " + nameText() + ", but the P2K changed preset or channel meanwhile: Send again to put it back.");
      } else {
        hideBanner();
        startSession();
        setStatus("Sent " + nameText() + " to the P2K's edit buffer (ch " + (Midi.channel + 1) + "). It isn't stored until you Write it.", "ok");
      }
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      S.busy = null;
      paintBar();
    }
  }

  async function writeToUnit(number) {
    if (S.busy || !S.preset) return;
    S.busy = "write";
    paintBar();
    const bank = number >> 7, pc = number & 127;
    let resend = false;
    try {
      if (!(await ready(false))) return;
      const snap = snapshotUnit();
      await prepareChannel();
      const version = S.version;
      const written = C.clonePreset(S.preset);
      setStatus("Writing " + nameText() + " to user " + bank + "·" + pc + "…");
      await uploadDump(written, number);
      await sleep(400);   // the unit stores to flash before it takes a program change
      // Select the stored preset, so the edit buffer and the Presets tab agree with it.
      const ch = Midi.channel;
      Midi.sendNow([0xb0 | ch, 0, 0]);
      Midi.sendNow([0xb0 | ch, 32, bank]);
      Midi.sendNow([0xc0 | ch, pc]);
      await sleep(150);
      UserNames.set(number, written.name);
      Presets.markActive(0, number);
      S.origin = { kind: "unit", romId: 0, number };
      S.lastSelected = { romId: 0, number, name: written.name };
      S.pristine = written;
      S.dirty = S.version !== version;     // edits made while it was being written aren't stored
      try { localStorage.setItem("sea-change:last-write", String(number)); } catch { /* not remembered */ }
      if (unitMoved(snap)) {
        S.live = false;
        setStatus("Wrote " + nameText() + " to user " + bank + "·" + pc + ", but the P2K changed channel meanwhile.");
      } else {
        startSession();
        resend = S.dirty;                    // the edit buffer has the stored version: add the newer edits
        setStatus("Wrote " + nameText() + " to user " + bank + "·" + pc + " and selected it.", "ok");
      }
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      S.busy = null;
      paintBar();
      scheduleRepaint(true);
      if (resend) sendToUnit();
    }
  }

  // Don't follow the unit any more: our edits stay local until the next Send.
  function keepEditing() {
    S.live = false;
    S.stale = null;
    hideBanner();
    paintBar();
    setStatus("Keeping your edits. The P2K is playing something else now: Send puts them back in its edit buffer.");
  }

  /* ============================ names/labels ============================= */
  function presetText(romId, number, name) {
    if (romId === null || romId === undefined) return name ? name.trim() : "the edit buffer";
    const rom = romId === 0 ? "User" : (D.romById(romId) || {}).id || "ROM " + romId;
    const nm = name || (romId === 0 ? UserNames.get(number) : D.presetName(romId, number));
    return rom + " " + (number >> 7) + "·" + (number & 127) + (nm ? " " + nm.trim() : "");
  }
  const nameText = () => (S.preset ? '"' + S.preset.name.trim() + '"' : "the preset");

  function originText() {
    const o = S.origin;
    if (!o) return "";
    if (o.kind === "file") return "File " + o.file + (o.count > 1 ? " (" + (o.index + 1) + " of " + o.count + ")" : "");
    if (o.kind === "init") return "Init (E-MU default preset)";
    if (o.romId === null) return "P2K edit buffer";
    return presetText(o.romId, o.number, o.romId === 0 ? "" : D.presetName(o.romId, o.number));
  }

  /* ============================== banner ================================= */
  let bannerResolve = null;
  function ask(text, actions) {
    const b = $("ed-banner");
    b.innerHTML = "";
    b.appendChild(el("span", "", text));
    if (bannerResolve) bannerResolve(undefined);
    return new Promise((resolve) => {
      bannerResolve = resolve;
      for (const [label, value] of actions) {
        const btn = el("button", "btn", label);
        btn.addEventListener("click", () => { bannerResolve = null; hideBanner(); resolve(value); });
        b.appendChild(btn);
      }
      b.hidden = false;
    });
  }
  function hideBanner() {
    $("ed-banner").hidden = true;
    if (bannerResolve) { const r = bannerResolve; bannerResolve = null; r(undefined); }
  }

  /* ============================== view =================================== */
  let REG = [];
  const reg = (update) => { REG.push(update); };

  let repaintQueued = false, rebuildQueued = false;
  function scheduleRepaint(rebuild) {
    if (rebuild) rebuildQueued = true;
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => {
      repaintQueued = false;
      if (!S.preset || $("view-editor").hidden) return;
      if (rebuildQueued) { rebuildQueued = false; buildPage(); }
      repaint();
    });
  }
  function repaint() {
    for (const u of REG) u();
    paintName();
    paintTabs();
    paintBar();
  }

  function paintName() {
    const nm = S.preset.name;
    const cat = nm.slice(0, 3), rest = nm.slice(4);
    if (document.activeElement !== $("ed-cat")) $("ed-cat").value = cat.trimEnd();
    if (document.activeElement !== $("ed-nm")) $("ed-nm").value = rest.trimEnd();
  }

  function paintBar() {
    const src = $("ed-src");
    src.innerHTML = "";
    const line1 = el("b", "", S.preset ? originText() : "No preset loaded");
    const line2 = el("span");
    if (S.busy) line2.textContent = "talking to the P2K…";
    else if (S.preset) {
      const parts = [];
      if (S.live) parts.push(["● in the P2K's edit buffer, ch " + (Midi.channel + 1), "live"]);
      else parts.push(["not on the P2K: Send to hear it", ""]);
      if (S.dirty) parts.push(["edited", "dirty"]);
      parts.forEach(([t, c], i) => {
        if (i) line2.append(" · ");
        line2.appendChild(el("span", c, t));
      });
    }
    src.append(line1, line2);
    const midiOut = !!Midi.output;
    $("ed-get").disabled = S.busy || !midiOut;
    $("ed-send").disabled = S.busy || !midiOut || !S.preset;
    $("ed-write").disabled = S.busy || !midiOut || !S.preset;
    $("ed-undo").disabled = !undoStack.length;
    $("ed-redo").disabled = !redoStack.length;
    $("ed-revert").disabled = !!S.busy || !S.dirty || !S.pristine;
    $("ed-save").disabled = !S.preset;
    $("ed-open").disabled = $("ed-init").disabled = !!S.busy;
  }

  const instrumentLabel = (l) => {
    const L = S.preset.layers[l];
    const n = L[1409], rom = L[1439];
    if (!n) return "None";
    const name = D.instrumentName(rom, n);
    return name ? name.slice(4).trim() : (D.romById(rom) ? "" : "ROM " + rom + " ") + "#" + n;
  };
  const layerMuted = (l) => { const L = S.preset.layers[l]; return !L[1409] || L[1410] <= -96; };

  function paintTabs() {
    const nav = $("ed-tabs");
    if (!nav.children.length) {
      const mk = (page, label) => {
        const b = el("button", "ed-tab");
        b.dataset.page = String(page);
        if (page !== "preset") { const sw = el("span", "sw"); sw.style.background = LAYER_COLORS[page]; b.appendChild(sw); }
        b.appendChild(el("span", "lbl", label));
        if (page !== "preset") b.appendChild(el("span", "ins"));
        b.addEventListener("click", () => showPage(page));
        nav.appendChild(b);
      };
      mk("preset", "Preset");
      for (let l = 0; l < 4; l++) mk(l, "Layer " + (l + 1));
    }
    for (const b of nav.children) {
      const page = b.dataset.page === "preset" ? "preset" : +b.dataset.page;
      b.classList.toggle("on", page === S.page);
      if (page !== "preset") {
        b.querySelector(".ins").textContent = instrumentLabel(page);
        b.classList.toggle("mute", layerMuted(page));
        b.title = layerMuted(page) ? "Silent: no instrument, or volume at -96 dB" : "";
      }
    }
  }

  function showPage(page) {
    if (S.page === page) return;
    S.page = page;
    buildPage();
    repaint();
    window.scrollTo({ top: Math.min(window.scrollY, $("ed-tabs").offsetTop - 60) });
  }

  /* ------------------------------ controls -------------------------------- */
  const { editable, slider, choice, toggle } = UI.controls({
    get: (id) => get(id),
    set: (id, v) => setParam(id, v),
    ctx: (id) => scope(id),
    reg: (update) => REG.push(update),
    repaint: () => scheduleRepaint(),
  });

  /* ----------------------------- ROM lists -------------------------------- */
  const { romOpts, instrumentOpts, presetOpts, riffOpts, arpOpts } = UI;

  /* ----------------------------- patchcords ------------------------------- */
  function cordTable(parent, base, count, srcOpts, dstOpts) {
    const wrap = el("div", "cords");
    wrap.style.columns = count > 12 ? "2 480px" : "2 440px";
    wrap.style.columnGap = "24px";
    parent.appendChild(wrap);
    for (let c = 0; c < count; c++) {
      const sId = base + c * 3, dId = sId + 1, aId = sId + 2;
      const row = el("div", "cord");
      row.style.breakInside = "avoid";
      row.style.marginBottom = "3px";
      const i = el("span", "i", String(c + 1));
      const ss = el("select"), ds = el("select");
      const r = el("input");
      r.type = "range"; r.min = "-100"; r.max = "100"; r.step = "1";
      const v = el("span", "v");
      row.append(i, ss, ds, r, v);
      wrap.appendChild(row);
      ss.addEventListener("change", () => setParam(sId, +ss.value));
      ds.addEventListener("change", () => setParam(dId, +ds.value));
      r.addEventListener("input", () => setParam(aId, +r.value));
      r.addEventListener("dblclick", () => setParam(aId, 0));
      editable(v, aId);
      ss.title = "Source"; ds.title = "Destination"; r.title = "Amount (double-click for 0)";
      reg(() => {
        const sv = get(sId), dv = get(dId), av = get(aId);
        if (!ss._vals || !ss._vals.has(sv)) fillSelect(ss, srcOpts, sv);
        if (!ds._vals || !ds._vals.has(dv)) fillSelect(ds, dstOpts, dv);
        ss.value = String(sv);
        ds.value = String(dv);
        if (+r.value !== av) r.value = String(av);
        v.textContent = D.signed(av);
        row.classList.toggle("dim", !sv || !dv);
      });
    }
  }

  /* ------------------------------ zones map ------------------------------- */
  function zonesCard(page) {
    const { card: c } = card(page, "Layers & links · key ranges", "wide");
    const W = 1000, X0 = 210, X1 = 990, ROW = 26, rows = 6;
    const H = rows * ROW + 22;
    const s = svg("svg", { class: "zones", viewBox: "0 0 " + W + " " + H }, c);
    const kx = (k) => X0 + (k / 128) * (X1 - X0);
    for (let o = 0; o <= 10; o++) {
      const x = kx(o * 12);
      svg("line", { x1: x, x2: x, y1: 0, y2: rows * ROW, stroke: "#33333b", "stroke-width": 1 }, s);
      const t = svg("text", { x, y: rows * ROW + 15, fill: "#6c6c75", "font-size": 11, "text-anchor": "middle" }, s);
      t.textContent = "C" + (o - 2);
    }
    const gfx = svg("g", {}, s);
    reg(() => {
      gfx.innerHTML = "";
      const L = S.preset.layers, Cm = S.preset.common;
      const items = [];
      for (let l = 0; l < 4; l++) {
        const x = L[l];
        items.push({ label: "L" + (l + 1) + "  " + instrumentLabel(l), color: LAYER_COLORS[l], lo: x[1413], hi: x[1415],
          lf: x[1414], hf: x[1416], vel: x[1417] + "–" + x[1419], mute: layerMuted(l), page: l });
      }
      for (let k = 0; k < 2; k++) {
        const b = 1281 + k * 9, preset = Cm[b], rom = Cm[1299 + k];
        const on = preset >= 0;
        const nm = on ? (rom === 0 ? UserNames.get(preset) : D.presetName(rom, preset)) : "";
        items.push({ label: "Link " + (k + 1) + "  " + (on ? (nm ? nm.slice(4).trim() : "#" + preset) : "off"),
          color: "#9a9aa3", lo: Cm[b + 5], hi: Cm[b + 6], lf: 0, hf: 0, vel: Cm[b + 7] + "–" + Cm[b + 8], mute: !on, page: "preset" });
      }
      items.forEach((it, i) => {
        const y = i * ROW;
        const g = svg("g", { class: it.page === "preset" ? "" : "row-hit" }, gfx);
        svg("rect", { class: "bg", x: 0, y: y + 1, width: W, height: ROW - 2, rx: 4, fill: "transparent" }, g);
        const t = svg("text", { x: 8, y: y + 17, fill: it.mute ? "#6c6c75" : "#e8e8ea", "font-size": 12.5 }, g);
        t.textContent = it.label.length > 27 ? it.label.slice(0, 26) + "…" : it.label;
        if (it.lo <= it.hi) {
          const x0 = kx(it.lo), x1 = kx(it.hi + 1);
          const gid = "zg" + i;
          const grad = svg("linearGradient", { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 }, g);
          const span = Math.max(1, it.hi + 1 - it.lo);
          const a = Math.min(0.5, it.lf / span), b = 1 - Math.min(0.5, it.hf / span);
          const op = it.mute ? 0.25 : 0.85;
          [[0, it.lf ? 0.1 : op], [a, op], [b, op], [1, it.hf ? 0.1 : op]].forEach(([off, o]) =>
            svg("stop", { offset: off, "stop-color": it.color, "stop-opacity": o }, grad));
          svg("rect", { x: x0, y: y + 5, width: Math.max(2, x1 - x0), height: ROW - 10, rx: 3, fill: "url(#" + gid + ")" }, g);
          const vt = svg("text", { x: x1 - 6, y: y + 17, fill: "#111", "font-size": 10.5, "text-anchor": "end", opacity: it.mute ? 0.5 : 0.8 }, g);
          vt.textContent = x1 - x0 > 110 ? D.noteName(it.lo) + "–" + D.noteName(it.hi) + "  vel " + it.vel : "";
        }
        if (it.page !== "preset") g.addEventListener("click", () => showPage(it.page));
      });
    });
  }

  /* ------------------------------ envelopes ------------------------------- */
  function envCard(page, e) {
    const { card: c, head } = card(page, e.label, "wide");
    head.appendChild(el("span", "spacer"));
    const modeSel = el("select");
    head.appendChild(modeSel);
    modeSel.addEventListener("change", () => setParam(e.mode, +modeSel.value));
    fillSelect(modeSel, P[e.mode].opts, 1);
    if (e.repeat) toggle(head, e.repeat, { bare: true, label: "Repeat" });
    const grid = el("div", "env-grid");
    c.appendChild(grid);
    const gwrap = el("div");
    grid.appendChild(gwrap);
    const s = svg("svg", { class: "env-svg", viewBox: "0 0 300 86", preserveAspectRatio: "none" }, gwrap);
    const note = el("p", "note");
    gwrap.appendChild(note);
    const stagesWrap = el("div", "env-stages");
    grid.appendChild(stagesWrap);
    const nice = ["Attack 1", "Decay 1", "Release 1", "Attack 2", "Decay 2", "Release 2"];
    const dimFactory = () => e.key === "vol" && get(e.mode) === 0;
    for (const i of D.STAGE_TIME_ORDER) {
      const col = el("div", "env-stage");
      col.appendChild(el("div", "cord-head", nice[i]));
      stagesWrap.appendChild(col);
      slider(col, e.base + i * 2, { label: "Rate", cls: "full", dim: dimFactory });
      slider(col, e.base + i * 2 + 1, { label: "Level", cls: "full", dim: dimFactory });
    }
    reg(() => {
      const L = S.preset.layers[curLayer()];
      if (modeSel.value !== String(L[e.mode])) {
        if (![...modeSel.options].some((o) => o.value === String(L[e.mode]))) fillSelect(modeSel, P[e.mode].opts, L[e.mode]);
        modeSel.value = String(L[e.mode]);
      }
      drawEnv(s, e, L);
      note.textContent = dimFactory()
        ? "Factory: the instrument's own volume envelope is used; the stages below are ignored."
        : (e.levelMin < 0 ? "Levels −100…+100 %. " : "") + "Decay 2 is the sustain level; Release follows key-up." +
          (L[e.mode] === 2 ? " Rates follow the tempo." : "");
    });
  }

  function drawEnv(s, e, L) {
    s.innerHTML = "";
    const W = 300, top = 8, bottom = 78;
    const bip = e.levelMin < 0;
    const y = (lvl) => (bip ? (top + bottom) / 2 - (lvl / 100) * ((bottom - top) / 2) : bottom - (lvl / 100) * (bottom - top));
    const rate = (i) => L[e.base + i * 2], level = (i) => L[e.base + i * 2 + 1];
    const seg = (r) => 3 + r * 0.55;
    const pts = [[0, y(0)]];
    let x = 0;
    for (const i of [0, 3, 1, 4]) { x += seg(rate(i)); pts.push([x, y(level(i))]); }
    x += 34;
    const keyUp = x;
    pts.push([x, y(level(4))]);
    for (const i of [2, 5]) { x += seg(rate(i)); pts.push([x, y(level(i))]); }
    const k = Math.min(1, (W - 8) / Math.max(1, x));
    const sx = (v) => 4 + v * k;
    if (bip) svg("line", { x1: 0, x2: W, y1: y(0), y2: y(0), stroke: "#3a3a42", "stroke-dasharray": "3 3" }, s);
    svg("line", { x1: sx(keyUp), x2: sx(keyUp), y1: 2, y2: 84, stroke: "#3a3a42", "stroke-dasharray": "2 3" }, s);
    const color = LAYER_COLORS[curLayer()];
    const d = pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const factory = e.key === "vol" && L[e.mode] === 0;
    svg("path", { d: d + " L" + sx(x).toFixed(1) + " " + y(0) + " L4 " + y(0) + " Z", fill: color, opacity: factory ? 0.05 : 0.14 }, s);
    svg("path", { d, fill: "none", stroke: color, "stroke-width": 1.8, opacity: factory ? 0.35 : 1, "stroke-dasharray": factory ? "4 3" : "" }, s);
    pts.slice(1).forEach((p) => svg("circle", { cx: sx(p[0]), cy: p[1], r: 2.2, fill: color, opacity: factory ? 0.35 : 1 }, s));
  }

  /* ------------------------------ pages ---------------------------------- */
  function buildPage() {
    const page = $("ed-page");
    page.innerHTML = "";
    REG = [];
    if (S.page === "preset") buildPresetPage(page);
    else buildLayerPage(page);
  }

  function buildPresetPage(page) {
    zonesCard(page);

    // Effects
    {
      const { card: c } = card(page, "Effects");
      const fxa = () => get(1153) === 0, fxb = () => get(1160) === 0;
      const a = sub(c, "FX A · reverbs & delays");
      choice(a, 1153, { label: "Algorithm", cls: "full" });
      [1154, 1155, 1156].forEach((id) => slider(a, id, { dim: fxa }));
      [1157, 1158, 1159, 1167].forEach((id) => slider(a, id, { dim: fxa }));
      const b = sub(c, "FX B · chorus, flange, delay, distortion");
      choice(b, 1160, { label: "Algorithm", cls: "full" });
      [1161, 1162, 1163].forEach((id) => slider(b, id, { dim: fxb }));
      [1164, 1165, 1166, 1168].forEach((id) => slider(b, id, { dim: fxb }));
      c.appendChild(el("p", "note", "Master FX: the preset uses the Master menu's effect settings instead."));
    }

    // Arpeggiator
    {
      const { card: c, head } = card(page, "Arpeggiator");
      head.appendChild(el("span", "spacer"));
      toggle(head, 1025, { bare: true, label: "Preset arp" });
      const off = () => !get(1025);
      const g = cells(c);
      choice(g, 1026, { dim: off });
      choice(g, 1028, { dim: off });
      choice(g, 1042, { label: "Pattern ROM", options: () => romOpts(null, true), dim: off });
      choice(g, 1027, { label: "Pattern", cls: "w2", options: () => arpOpts(get(1042)), sig: () => get(1042), dim: () => off() || get(1026) !== 7 });
      [1029, 1030, 1031, 1032].forEach((id) => slider(g, id, { dim: off }));
      [1033, 1041, 1034, 1035, 1043, 1036].forEach((id) => choice(g, id, { dim: off }));
      [1039, 1040].forEach((id) => slider(g, id, { dim: off }));
      [1037, 1038].forEach((id) => toggle(g, id, { dim: off }));
    }

    // Links
    {
      const { card: c } = card(page, "Links");
      for (let k = 0; k < 2; k++) {
        const b = 1281 + k * 9, romId = 1299 + k;
        const off = () => get(b) < 0;
        const g = sub(c, "Link " + (k + 1));
        choice(g, romId, { label: "ROM", options: () => romOpts("banks", true) });
        choice(g, b, { label: "Preset", cls: "w2", options: () => presetOpts(get(romId)), sig: () => get(romId) + ":" + (get(romId) === 0 ? userNamesVersion : 0) });
        [b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8].forEach((id) => slider(g, id, { dim: off }));
      }
    }

    // Controllers, tempo, tuning, riff
    {
      const { card: c } = card(page, "Controllers & tempo");
      c.appendChild(el("p", "note", "Initial amounts of the knobs/MIDI controllers A–L when the preset is selected. Off keeps the current value."));
      const g = cells(c);
      [915, 916, 917, 918, 919, 920, 921, 922, 924, 925, 926, 927, 967, 968, 969, 970].forEach((id) => slider(g, id));
      const t = sub(c, "Tempo, tuning & audition");
      choice(t, 930);
      choice(t, 923);
      choice(t, 929, { label: "Riff ROM", options: () => romOpts("riffs", false) });
      choice(t, 928, { label: "Audition riff", cls: "w2", options: () => riffOpts(get(929)), sig: () => get(929) });
    }

    // Preset patchcords
    {
      const { card: c } = card(page, "Preset patchcords", "wide");
      c.appendChild(el("p", "note", "Cords that act on the whole preset: effects sends, arpeggiator, preset lag/ramp."));
      cordTable(c, 931, 12, D.PRESET_CORD_SRC, D.PRESET_CORD_DST);
    }
  }

  function buildLayerPage(page) {
    const l = curLayer();
    const color = LAYER_COLORS[l];

    // Instrument
    {
      const { card: c, head } = card(page, "Layer " + (l + 1) + " · instrument", "wide");
      head.firstChild.style.color = color;
      head.appendChild(el("span", "spacer"));
      const copy = el("select");
      copy.title = "Copy all of this layer's settings to another layer";
      fillSelect(copy, [[-1, "Copy layer to…"], ...[0, 1, 2, 3].filter((x) => x !== l).map((x) => [x, "Layer " + (x + 1)])], -1);
      copy.addEventListener("change", () => {
        const to = +copy.value;
        copy.value = "-1";
        if (to < 0) return;
        const p = C.clonePreset(S.preset);
        p.layers[to] = Object.assign({}, p.layers[l]);
        if (!replacePreset(p)) return;
        setStatus("Copied layer " + (l + 1) + " to layer " + (to + 1) + (S.live ? " and sent the preset." : "."), "ok");
      });
      head.appendChild(copy);
      const g = cells(c);
      choice(g, 1439, { label: "ROM", options: () => romOpts("instruments", false) });
      choice(g, 1409, { label: "Instrument", cls: "w2", options: () => instrumentOpts(get(1439)), sig: () => get(1439) });
      slider(g, 1410);
      slider(g, 1411);
      choice(g, 1412);
    }

    // Tuning
    {
      const { card: c } = card(page, "Tuning & pitch");
      const g = cells(c);
      [1425, 1426, 1429, 1431, 1427, 1428].forEach((id) => slider(g, id));
      toggle(g, 1430);
      c.appendChild(el("p", "note", "Transpose shifts the keyboard; coarse tune shifts the sample. Non-transpose ignores the keyboard (drums, FX)."));
    }

    // Ranges
    {
      const { card: c } = card(page, "Key, velocity & real-time ranges");
      const short = { 1413: "Low", 1414: "Low fade", 1415: "High", 1416: "High fade" };
      [["Key", 1413], ["Velocity", 1417], ["Real-time (RT crossfade cord)", 1421]].forEach(([title, base]) => {
        const g = sub(c, title, "q4");
        for (let i = 0; i < 4; i++) slider(g, base + i, { label: short[1413 + i] });
      });
    }

    // Voice
    {
      const { card: c } = card(page, "Glide, solo & start");
      const g = cells(c);
      slider(g, 1432, { cls: "w2" });
      choice(g, 1433);
      choice(g, 1437);
      choice(g, 1438);
      slider(g, 1436);
      slider(g, 1435);
    }

    // Filter
    {
      const { card: c } = card(page, "Filter");
      const g = cells(c);
      choice(g, 1537, { label: "Type", cls: "full" });
      const knobs = () => D.FILTER_KNOBS[D.filterClass(get(1537))];
      const off = () => get(1537) === 127;
      slider(g, 1538, { dynLabel: () => knobs()[0], dim: off });
      slider(g, 1539, { dynLabel: () => knobs()[1], dim: off });
      const n = el("p", "note");
      c.appendChild(n);
      reg(() => {
        const cls = D.filterClass(get(1537));
        n.textContent = {
          off: "No filter.",
          lp: "Low-pass, cutoff 57 Hz – 20 kHz.",
          hp: "High-pass, cutoff 69 Hz – 18 kHz.",
          bp: "Band-pass.",
          eq: "Swept EQ: center 83 Hz – 10 kHz, gain ±24 dB.",
          vow: "Vowel morph: Freq morphs between the vowels, Q sets the body size.",
          other: "12-pole Z-plane filter: Freq and Q steer its morph.",
        }[cls];
      });
    }

    // LFOs
    for (let k = 0; k < 2; k++) {
      const b = 1665 + k * 5;
      const { card: c } = card(page, "LFO " + (k + 1));
      const g = cells(c);
      choice(g, b + 1);
      choice(g, b + 4);
      slider(g, b);
      slider(g, b + 2);
      slider(g, b + 3);
    }

    // Envelopes
    D.ENVS.forEach((e) => envCard(page, e));

    // Patchcords
    {
      const { card: c } = card(page, "Layer patchcords", "wide");
      c.appendChild(el("p", "note", "Source → destination, amount −100…+100. Rows with an Off end are dimmed."));
      cordTable(c, 1921, 24, D.LAYER_CORD_SRC, D.LAYER_CORD_DST);
    }
  }

  // Bumped when user names change, so preset lists that show them rebuild.
  let userNamesVersion = 0;
  UserNames.subscribe(() => { userNamesVersion++; scheduleRepaint(); fillWriteList(); });

  /* ------------------------------ files ---------------------------------- */
  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const found = C.presetsFromSysex(new Uint8Array(reader.result));
      if (!found.length) { setStatus("No Proteus preset dump in " + file.name + ".", "err"); return; }
      let idx = 0;
      if (found.length > 1) {
        idx = await pickPreset(found, file.name);
        if (idx < 0) return;
      }
      const f = found[idx];
      if (!replacePreset(f.preset, { origin: { kind: "file", file: file.name, index: idx, count: found.length }, send: false })) return;
      S.live = false;
      S.pristine = C.clonePreset(f.preset);
      S.dirty = false;
      if (Midi.output) await sendToUnit();
      else setStatus("Opened " + nameText() + " from " + file.name + ".", "ok");
    };
    reader.readAsArrayBuffer(file);
  }

  function pickPreset(found, fileName) {
    const dlg = $("pick-dlg"), list = $("pick-list");
    $("pick-info").textContent = fileName + " holds " + found.length + " presets.";
    list.innerHTML = "";
    found.forEach((f, i) => {
      const where = f.number < 0 ? "edit buffer" : (f.romId === 0 ? "user " : "ROM " + f.romId + " ") + (f.number >> 7) + "·" + (f.number & 127);
      const o = el("option", "", f.preset.name.trim() + "   (" + where + ")");
      o.value = String(i);
      list.appendChild(o);
    });
    list.value = "0";
    return new Promise((resolve) => {
      const done = (v) => { dlg.close(); resolve(v); };
      $("pick-ok").onclick = () => done(+list.value);
      list.ondblclick = () => done(+list.value);
      $("pick-cancel").onclick = () => done(-1);
      dlg.oncancel = () => resolve(-1);
      dlg.showModal();
    });
  }

  function saveFile() {
    const bytes = C.concat(C.encodePreset(S.preset, { dev: 0, number: C.EDIT_BUFFER, romId: 0 }));
    const base = S.preset.name.replace(/[^A-Za-z0-9 _.+&-]+/g, " ").trim().replace(/\s+/g, " ") || "preset";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = base + ".syx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus("Saved " + a.download + " (an edit-buffer dump: sending it to a P2K loads it without storing).", "ok");
  }

  /* ------------------------------ write dialog --------------------------- */
  function fillWriteList() {
    const bank = +$("wr-bank").value, sel = $("wr-num"), keep = sel.value;
    sel.innerHTML = "";
    for (let pc = 0; pc < 128; pc++) {
      const n = bank * 128 + pc;
      const o = el("option", "", pc + "  " + (UserNames.get(n) || "(name not read)"));
      o.value = String(n);
      sel.appendChild(o);
    }
    if (keep && +keep >> 7 === bank) sel.value = keep;
  }
  function openWrite() {
    let n = S.origin && S.origin.kind === "unit" && S.origin.romId === 0 ? S.origin.number : null;
    if (n === null) {
      let last = NaN;
      try { last = parseInt(localStorage.getItem("sea-change:last-write"), 10); } catch { /* storage blocked */ }
      n = Number.isNaN(last) ? 0 : last;
    }
    $("wr-bank").value = String(n >> 7);
    fillWriteList();
    $("wr-num").value = String(n);
    $("write-dlg").showModal();
  }
  $("wr-bank").addEventListener("change", fillWriteList);
  $("wr-cancel").addEventListener("click", () => $("write-dlg").close());
  $("wr-ok").addEventListener("click", () => {
    const n = +$("wr-num").value;
    $("write-dlg").close();
    writeToUnit(n);
  });
  $("wr-names").addEventListener("click", async () => {
    const btn = $("wr-names");
    if (UserNames.scanning) { UserNames.scan(); return; }
    btn.textContent = "Stop";
    const bank = +$("wr-bank").value;
    try {
      const ok = await UserNames.scan({ from: bank * 128, count: 128,
        onProgress: (i, n) => setStatus("Reading user bank " + bank + " names " + i + "/" + n + "…") });
      if (ok) setStatus("Read the names of user bank " + bank + ".", "ok");
      else if (!/err/.test($("status").className)) setStatus("Stopped reading names.");
    } catch (e) {
      setStatus(e.message, "err");
    } finally {
      btn.textContent = "Read names";
    }
  });

  /* ------------------------------ keyboard ------------------------------- */
  const KB = { base: 48, held: new Map(), pointer: null };
  function noteOn(n) {
    if (n < 0 || n > 127 || KB.held.has(n)) return;
    const vel = +$("kb-vel").value;
    Midi.sendNow([0x90 | Midi.channel, n, vel]);
    KB.held.set(n, Midi.channel);
    paintKeys();
  }
  function noteOff(n) {
    if (!KB.held.has(n)) return;
    Midi.sendNow([0x80 | KB.held.get(n), n, 0]);
    KB.held.delete(n);
    paintKeys();
  }
  function buildKeys() {
    const keys = $("keys");
    keys.innerHTML = "";
    const span = 36;
    const whites = [];
    for (let i = 0; i <= span; i++) if (![1, 3, 6, 8, 10].includes(i % 12)) whites.push(i);
    const w = 100 / whites.length;
    for (let i = 0; i <= span; i++) {
      const n = KB.base + i;
      const black = [1, 3, 6, 8, 10].includes(i % 12);
      const k = el("div", "key " + (black ? "b" : "w"));
      k.dataset.note = String(n);
      if (black) {
        const wi = whites.filter((x) => x < i).length;
        k.style.left = (wi * w - w * 0.3) + "%";
        k.style.width = (w * 0.6) + "%";
      } else {
        const wi = whites.indexOf(i);
        k.style.left = (wi * w) + "%";
        k.style.width = w + "%";
        if (i % 12 === 0) k.appendChild(el("span", "lbl", D.noteName(n)));
      }
      keys.appendChild(k);
    }
    $("kb-oct").textContent = D.noteName(KB.base);
  }
  function paintKeys() {
    for (const k of $("keys").children) k.classList.toggle("down", KB.held.has(+k.dataset.note));
  }
  function keyAt(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    return t && t.closest && t.closest(".key") ? +t.closest(".key").dataset.note : null;
  }
  $("keys").addEventListener("pointerdown", (e) => {
    const n = keyAt(e);
    if (n === null) return;
    e.preventDefault();
    $("keys").setPointerCapture(e.pointerId);
    KB.pointer = n;
    noteOn(n);
  });
  $("keys").addEventListener("pointermove", (e) => {
    if (KB.pointer === null) return;
    const n = keyAt(e);
    if (n === null || n === KB.pointer) return;
    noteOff(KB.pointer);
    KB.pointer = n;
    noteOn(n);
  });
  const release = () => { if (KB.pointer !== null) { noteOff(KB.pointer); KB.pointer = null; } };
  $("keys").addEventListener("pointerup", release);
  $("keys").addEventListener("pointercancel", release);
  $("kb-down").addEventListener("click", () => { allOff(); KB.base = Math.max(0, KB.base - 12); buildKeys(); });
  $("kb-up").addEventListener("click", () => { allOff(); KB.base = Math.min(84, KB.base + 12); buildKeys(); });
  $("kb-vel").addEventListener("input", () => { $("kb-vel-v").textContent = $("kb-vel").value; });
  function allOff() { for (const n of [...KB.held.keys()]) noteOff(n); }
  $("kb-panic").addEventListener("click", () => {
    allOff();
    const ch = Midi.channel;
    Midi.sendNow([0xb0 | ch, 64, 0]);
    Midi.sendNow([0xb0 | ch, 123, 0]);
    Midi.sendNow([0xb0 | ch, 120, 0]);
  });
  // Computer keyboard: Z..M = base octave, Q..U = the next one.
  const KEYMAP = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ",": 12,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24 };
  const typing = (t) => t && (t.tagName === "INPUT" && t.type !== "range" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  document.addEventListener("keydown", (e) => {
    if ($("view-editor").hidden || document.querySelector("dialog[open]")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod || e.altKey || typing(e.target) || e.repeat) return;
    const off = KEYMAP[e.key.toLowerCase()];
    if (off === undefined) return;
    e.preventDefault();
    noteOn(KB.base + off);
  });
  document.addEventListener("keyup", (e) => {
    const off = KEYMAP[e.key.toLowerCase()];
    if (off !== undefined) noteOff(KB.base + off);
  });
  window.addEventListener("blur", allOff);

  /* ------------------------------ wiring --------------------------------- */
  function onNameInput() {
    const cat = $("ed-cat").value.slice(0, 3).padEnd(3);
    const nm = $("ed-nm").value.slice(0, 12).padEnd(12);
    setName(cat + ":" + nm);
  }
  $("ed-cat").addEventListener("input", onNameInput);
  $("ed-nm").addEventListener("input", onNameInput);
  $("ed-get").addEventListener("click", () => getFromUnit());
  $("ed-send").addEventListener("click", () => sendToUnit());
  $("ed-write").addEventListener("click", openWrite);
  $("ed-undo").addEventListener("click", undo);
  $("ed-redo").addEventListener("click", redo);
  $("ed-revert").addEventListener("click", () => {
    if (!S.pristine || !replacePreset(C.clonePreset(S.pristine))) return;
    S.dirty = false;
    paintBar();
    setStatus("Reverted to " + nameText() + " as loaded" + (S.live ? " and sent it to the P2K." : "."), "ok");
  });
  $("ed-open").addEventListener("click", () => $("ed-file").click());
  $("ed-file").addEventListener("change", () => {
    const f = $("ed-file").files[0];
    $("ed-file").value = "";
    if (f) loadFile(f);
  });
  $("ed-save").addEventListener("click", saveFile);
  $("ed-init").addEventListener("click", () => {
    const p = initPreset();
    if (!replacePreset(p, { origin: { kind: "init" }, send: false })) return;
    S.live = false;
    S.pristine = C.clonePreset(p);
    if (Midi.output) sendToUnit();
  });
  // Drop a .syx file anywhere on the editor.
  $("view-editor").addEventListener("dragover", (e) => { e.preventDefault(); });
  $("view-editor").addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // Another input or SysEx ID: the basic-channel check has to be redone.
  $("inport").addEventListener("change", () => { preparedChannel = null; });
  $("devid").addEventListener("change", () => { preparedChannel = null; });
  // Another channel means another edit buffer: stop sending live edits until Get or Send.
  $("channel").addEventListener("change", () => {
    preparedChannel = null;
    allOff();
    if (S.live) {
      S.live = false;
      paintBar();
      setStatus("Channel changed: Get or Send to edit the preset on channel " + (Midi.channel + 1) + ".");
    }
  });

  // The Setup tab changed the basic channel or loaded another setup: the edit
  // buffer may be another one now.
  document.addEventListener("p2k:setup-changed", () => {
    preparedChannel = null;
    if (S.live) {
      S.live = false;
      paintBar();
    }
  });

  // The Presets tab changed the unit's preset: what we show is no longer what it plays.
  document.addEventListener("p2k:preset-selected", (e) => {
    S.lastSelect = performance.now();
    S.lastSelected = e.detail;
    S.selections++;
    if (!S.preset) return;
    S.stale = e.detail;
    S.live = false;
    paintBar();
  });

  /* ------------------------------ entry points --------------------------- */
  let built = false;
  function shown() {
    if (!built) {
      built = true;
      buildKeys();
    }
    if (!S.preset) {
      S.preset = initPreset();
      S.pristine = C.clonePreset(S.preset);
      S.origin = { kind: "init" };
      buildPage();
      repaint();
      // First visit: read what the P2K is playing, if we can reach it.
      if (Midi.output && Midi.input) getFromUnit();
      else setStatus("Editor: pick the MIDI output and input of the P2K, then Get from P2K. Until then you're editing E-MU's default preset offline.");
      return;
    }
    scheduleRepaint(true);
    if (S.stale) {
      if (!S.dirty) getFromUnit();
      else showStaleBanner();
    }
  }

  function showStaleBanner() {
    const what = presetText(S.stale.romId, S.stale.number, S.stale.name);
    ask("The P2K is now playing " + what + ". Your edits to " + nameText() + " haven't been written.",
      [["Load " + (S.stale.name ? S.stale.name.trim() : "it"), "load"], ["Keep editing", "keep"]])
      .then((v) => {
        if (v === "load") getFromUnit({ force: true });
        else if (v === "keep") keepEditing();
      });
  }

  // From a double-click in the Presets tab.
  function requestLoad() {
    if (S.busy) return;
    if (S.dirty && S.preset && S.stale) showStaleBanner();
    else getFromUnit();
  }

  return { shown, getFromUnit: requestLoad };
})();
