"use strict";
/* ============================================================================
 * sim — a simulated Proteus 2000 for development (index.html?sim).
 *
 * Replaces navigator.requestMIDIAccess with one in-page port pair wired to a
 * fake unit that speaks the parts of the SysEx protocol the app uses: program
 * changes, parameter edits and requests (with LAYER_SELECT and the multimode
 * channel select), closed- and open-loop preset dumps in both directions,
 * preset and setup name requests, setup dumps and Copy Setup. It
 * follows the spec, so it proves the app's side of the conversation, not the
 * unit's quirks. Inspect it as window.SIM (SIM.log holds every message in).
 * ==========================================================================*/
(() => {
  if (!/[?&]sim\b/.test(location.search)) return;

  const later = (fn, ms = 4) => setTimeout(fn, ms);
  const sim = {
    log: [],
    dev: 0,
    basicChannel: 0,
    user: [],          // 512 user presets
    edit: null,        // edit buffer
    presetSelect: -1,
    layerSelect: -1,
    banks: Array.from({ length: 16 }, () => ({ msb: 4, lsb: 0 })),
    current: { romId: 4, number: 0 },
    setup: null,       // current multisetup: { name, common, channels, counts }
    stored: [],        // 128 stored setups
    beats: null,       // { triggers: [{160, 161}] x24, parts: [{164, 165, 166}] x16 }
  };
  window.SIM = sim;

  let input = null;
  const reply = (bytes) => later(() => {
    if (input && input.onmidimessage) input.onmidimessage({ data: new Uint8Array(bytes) });
  });

  function base() { return P2KC.presetsFromSysex(P2KC.fromHex(P2KD.INIT_SYX))[0].preset; }
  for (let n = 0; n < 512; n++) {
    const p = base();
    p.name = ("usr:User " + (n >> 7) + "-" + (n & 127)).padEnd(16).slice(0, 16);
    sim.user.push(p);
  }
  function load(romId, number) {
    if (romId === 0) return P2KC.clonePreset(sim.user[number] || base());
    const p = base();
    p.name = (P2KD.presetName(romId, number) || "rom:Preset " + number).padEnd(16).slice(0, 16);
    p.layers[0][1439] = romId;
    p.layers[0][1409] = 1 + (number % 50);
    return p;
  }
  sim.edit = load(4, 0);

  function defaultSetup(n) {
    const c = P2KC.DEFAULT_SETUP_COUNTS;
    const common = {};
    const put = (ids, f) => ids.forEach((id, i) => { common[id] = f(id, i); });
    put(P2KC.SETUP_LAYOUTS[0].general(c.general), () => 0);
    put(P2KC.SETUP_LAYOUTS[0].midi(c.midi), () => 0);
    Object.assign(common, {
      257: 120, 264: 2, 266: 1, 271: 2, 272: -1, 273: -1, 277: 13, 278: 0,
      385: 2, 386: 1, 388: sim.dev, 402: -3, 403: -3, 405: 300,
      391: 21, 392: 22, 393: 23, 394: 24, 395: 25, 396: 26, 397: 27, 398: 28,
      399: 64, 400: 65, 401: 66, 406: 70, 407: 71, 408: 72, 409: 73,
    });
    for (let i = 0; i < c.fx; i++) common[513 + i] = [5, 40, 64, 0, 20, 0, 0, 8, 10, 30, 12, 15, 0, 0, 0, 0][i];
    for (let i = 0; i < c.arp; i++) common[641 + i] = 0;
    Object.assign(common, { 644: 7, 646: 100, 648: 1, 656: 127, 660: 13 });
    Object.assign(common, { 139: 0, 140: -1, 141: 0 });
    const channels = Array.from({ length: c.channels }, (_, ch) => ({
      130: ch * 3 + n, 131: 127, 132: 64, 133: -1, 134: -2, 135: 1, 136: 0, 137: 1, 138: ch < 8 ? 4 : 13,
    }));
    return { name: ("Setup " + n).padEnd(16).slice(0, 16), common, channels, counts: Object.assign({}, c) };
  }
  const cloneSetup = (x) => JSON.parse(JSON.stringify(x));
  for (let n = 0; n < 128; n++) sim.stored.push(defaultSetup(n));
  sim.setup = cloneSetup(sim.stored[0]);
  sim.beats = {
    triggers: Array.from({ length: 24 }, (_, t) => ({ 160: 36 + t, 161: t >= 20 ? 1 : 0 })),
    parts: Array.from({ length: 16 }, (_, p) => ({ 164: -1, 165: 0, 166: p < 4 ? 1 : p < 8 ? 2 : p < 12 ? 3 : 4 })),
  };

  /* --------------------------- outgoing dumps --------------------------- */
  let outDump = null;   // { msgs, next }
  function sendDump(preset, number, romId, closed) {
    const msgs = P2KC.encodePreset(preset, { dev: sim.dev, number, romId, closed });
    if (!closed) { msgs.forEach((m, i) => later(() => reply(m), 20 * i)); return; }
    outDump = { msgs, next: 1 };
    reply(msgs[0]);
  }

  /* --------------------------- incoming dumps --------------------------- */
  const asm = P2KC.PresetAssembler();
  let inHeader = null;

  function setParam(id, v) {
    if (id === 897) { sim.presetSelect = v; return; }
    if (id === 898) { sim.layerSelect = v; return; }
    if (id === 129) { sim.p129 = v; return; }
    if (id === 139) sim.basicChannel = v;
    if (id >= 130 && id <= 138) { sim.setup.channels[sim.p129 | 0][id] = v; return; }
    if (id >= 142 && id <= 157) {
      const nm = sim.setup.name.split("");
      nm[id - 142] = String.fromCharCode(v);
      sim.setup.name = nm.join("");
      return;
    }
    if (id === 160 || id === 161) { sim.beats.triggers[sim.layerSelect][id] = v; return; }
    if (id >= 164 && id <= 166) { sim.beats.parts[sim.layerSelect][id] = v; return; }
    if (id in sim.setup.common) { sim.setup.common[id] = v; return; }
    if (id >= 899 && id <= 914) {
      const nm = sim.edit.name.split("");
      nm[id - 899] = String.fromCharCode(v);
      sim.edit.name = nm.join("");
      return;
    }
    if (id >= 1408) {
      const layers = sim.layerSelect < 0 ? [0, 1, 2, 3] : [sim.layerSelect];
      layers.forEach((l) => { sim.edit.layers[l][id] = v; });
    } else if (id >= 915) {
      sim.edit.common[id] = v;
    }
  }
  function getParam(id) {
    if (id === 160 || id === 161) return sim.beats.triggers[sim.layerSelect][id];
    if (id >= 164 && id <= 166) return sim.beats.parts[sim.layerSelect][id];
    if (id >= 130 && id <= 138) return sim.setup.channels[sim.p129 | 0][id];
    if (id in sim.setup.common) return sim.setup.common[id];
    if (id >= 1408) return sim.edit.layers[Math.max(0, sim.layerSelect)][id] | 0;
    return sim.edit.common[id] | 0;
  }

  function receive(d) {
    sim.log.push(P2KC.hex(d));
    const s = d[0] & 0xf0, ch = d[0] & 0x0f;
    if (s === 0xb0) {
      if (d[1] === 0) sim.banks[ch].msb = d[2];
      if (d[1] === 32) sim.banks[ch].lsb = d[2];
      return;
    }
    if (s === 0xc0) {
      const b = sim.banks[ch], number = b.lsb * 128 + d[1];
      if (sim.setup.channels[ch][137]) Object.assign(sim.setup.channels[ch], { 138: b.msb, 130: number });
      if (ch === sim.basicChannel) {
        sim.current = { romId: b.msb, number };
        sim.edit = load(sim.current.romId, sim.current.number);
      }
      return;
    }
    if (d[0] !== 0xf0) return;
    const m = P2KC.classify(d);
    if (!m || m.type === "identity") return;
    const raw = d;
    switch (m.type) {
      case "param":
        m.params.forEach(([id, v]) => setParam(id, v));
        return;
      case "ack":
        if (outDump && outDump.next < outDump.msgs.length) reply(outDump.msgs[outDump.next++]);
        else if (outDump) { reply(P2KC.eof(sim.dev)); outDump = null; }
        return;
      case "dumpHeader":
      case "dumpData": {
        if (m.type === "dumpHeader") inHeader = m;
        const r = asm.feed(m);
        if (r && r.ack !== undefined) reply(P2KC.ack(sim.dev, r.ack));
        if (r && r.nak !== undefined) reply(P2KC.nak(sim.dev, r.nak));
        if (r && r.done) {
          if (r.number < 0) sim.edit = r.preset;
          else if (r.romId === 0) sim.user[r.number] = r.preset;
          inHeader = null;
        }
        return;
      }
      default: break;
    }
    if (raw[5] === P2KC.CMD.PARAM_REQ) {
      const n = raw[6];
      for (let i = 0; i < n; i++) {
        const id = P2KC.decU14(raw[7 + i * 2], raw[8 + i * 2]);
        reply(P2KC.paramEdit(sim.dev, [[id, getParam(id)]]));
      }
    } else if (raw[5] === P2KC.CMD.PRESET_DUMP_REQ) {
      const closed = raw[6] === 0x02;
      const number = P2KC.dec14(raw[7], raw[8]), romId = P2KC.decU14(raw[9], raw[10]);
      const p = number < 0 ? sim.edit : load(romId, number);
      sendDump(p, number < 0 ? -1 : number, number < 0 ? 0 : romId, closed);
    } else if (raw[5] === P2KC.CMD.SETUP_DUMP_REQ) {
      sim.setup.common[388] = sim.dev;
      reply(P2KC.encodeSetup(sim.setup, { dev: sim.dev }));
    } else if (raw[5] === P2KC.CMD.COPY_SETUP) {
      const src = P2KC.dec14(raw[6], raw[7]), dst = P2KC.dec14(raw[8], raw[9]);
      if (dst < 0) { sim.setup = cloneSetup(sim.stored[src]); sim.basicChannel = sim.setup.common[139]; }
      else if (src < 0) sim.stored[dst] = cloneSetup(sim.setup);
    } else if (raw[5] === P2KC.CMD.NAME_REQ) {
      const type = raw[6], number = P2KC.decU14(raw[7], raw[8]), romId = P2KC.decU14(raw[9], raw[10]);
      const name = type === 4 ? sim.stored[number].name
        : type === 1 && romId === 0 ? sim.user[number].name : (P2KD.presetName(romId, number) || "").padEnd(16);
      reply([0xf0, 0x18, 0x0f, sim.dev, 0x55, 0x0b, type, ...P2KC.enc14(number), ...P2KC.enc14(romId),
        ...name.slice(0, 16).split("").map((c) => c.charCodeAt(0)), 0xf7]);
    } else if (raw[5] === P2KC.CMD.EOF || raw[5] === P2KC.CMD.CANCEL) {
      asm.reset();
    }
  }

  const output = { id: "sim-out", name: "Simulated P2K", manufacturer: "Sea Change", send: (b) => receive(Uint8Array.from(b)) };
  input = { id: "sim-in", name: "Simulated P2K", manufacturer: "Sea Change", onmidimessage: null };
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map([[output.id, output]]),
    onstatechange: null,
    sysexEnabled: true,
  };
  navigator.requestMIDIAccess = () => Promise.resolve(access);
})();
