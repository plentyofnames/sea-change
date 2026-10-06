"use strict";
/* ============================================================================
 * sim — a simulated Proteus 2000 for development (index.html?sim).
 *
 * Replaces navigator.requestMIDIAccess with one in-page port pair wired to a
 * fake unit that speaks the parts of the SysEx protocol the app uses: program
 * changes, parameter edits and requests (with LAYER_SELECT), closed- and
 * open-loop preset dumps in both directions, and preset name requests. It
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
    bank: { msb: 4, lsb: 0 },
    current: { romId: 4, number: 0 },
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
    if (id === 139) { sim.basicChannel = v; return; }
    if (id === 129 || id === 138) { sim["p" + id] = v; return; }
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
    if (id === 139) return sim.basicChannel;
    if (id >= 1408) return sim.edit.layers[Math.max(0, sim.layerSelect)][id] | 0;
    return sim.edit.common[id] | 0;
  }

  function receive(d) {
    sim.log.push(P2KC.hex(d));
    const s = d[0] & 0xf0, ch = d[0] & 0x0f;
    if (s === 0xb0 && ch === sim.basicChannel) {
      if (d[1] === 0) sim.bank.msb = d[2];
      if (d[1] === 32) sim.bank.lsb = d[2];
      return;
    }
    if (s === 0xc0 && ch === sim.basicChannel) {
      sim.current = { romId: sim.bank.msb, number: sim.bank.lsb * 128 + d[1] };
      sim.edit = load(sim.current.romId, sim.current.number);
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
    } else if (raw[5] === P2KC.CMD.NAME_REQ) {
      const type = raw[6], number = P2KC.decU14(raw[7], raw[8]), romId = P2KC.decU14(raw[9], raw[10]);
      const name = type === 1 && romId === 0 ? sim.user[number].name : (P2KD.presetName(romId, number) || "").padEnd(16);
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
