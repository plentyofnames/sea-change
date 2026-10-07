"use strict";
/* ============================================================================
 * p2k-core — pure, DOM-free Proteus 2000 SysEx encode/decode (P2KC).
 *
 * Reference: E-MU "Proteus Family System Exclusive Specification" v2.2,
 * cross-checked against Edisyn (EmuProteus2000.java) and prodatum (pxk.C,
 * midi.C, data.C), which both talk to real units.
 *
 * Framing:  F0 18 0F <dev> 55 <cmd> ... F7
 * Numbers:  14-bit two's complement, LSB first (enc14 / dec14).
 *
 * A preset is a plain object:
 *   { name:   16-char string ("cat:Name"),
 *     common: { [paramId]: value }   ids 915.., 1025.., 1153.., 1281..
 *     layers: [ { [paramId]: value } x4 ]   ids 1409.., 1537.., 1665.., 1793.., 1921..
 *     counts: section sizes from the dump header (firmware-dependent; kept so a
 *             re-encode reproduces exactly what the unit sent) }
 * Values are always raw (what goes over the wire); display mapping lives in
 * p2k-data.js. Unknown ids/values are carried through untouched.
 * ==========================================================================*/
const P2KC = (() => {
  const EMU = 0x18, PROTEUS = 0x0f, EDITOR = 0x55;

  const CMD = {
    PARAM_EDIT: 0x01, PARAM_REQ: 0x02,
    CONFIG: 0x09, CONFIG_REQ: 0x0a,
    NAME: 0x0b, NAME_REQ: 0x0c,
    PRESET_DUMP: 0x10, PRESET_DUMP_REQ: 0x11,
    SETUP_DUMP: 0x1c, SETUP_DUMP_REQ: 0x1d,
    COPY_PRESET: 0x20, COPY_SETUP: 0x2c,
    ERROR: 0x70,
    EOF: 0x7b, WAIT: 0x7c, CANCEL: 0x7d, NAK: 0x7e, ACK: 0x7f,
  };

  // Preset number for the edit buffer (sent as 7F 7F).
  const EDIT_BUFFER = -1;

  // Generic Name object types.
  const OBJ = { PRESET: 1, INSTRUMENT: 2, ARP: 3, SETUP: 4, DEMO: 5, RIFF: 6 };

  // Dump sections, in dump order. Param ids run base+1 .. base+count.
  // The name (16 single ASCII bytes, ids 899..914) precedes "general".
  const COMMON_SECTIONS = [
    { key: "general", base: 914 },   // 915.. ctrl A-L, tuning, riff, tempo, 12 preset cords, ctrl M-P
    { key: "arp", base: 1024 },      // 1025.. (the header calls this "reserved")
    { key: "fx", base: 1152 },       // 1153..
    { key: "link", base: 1280 },     // 1281..
  ];
  const LAYER_SECTIONS = [
    { key: "lgeneral", base: 1408 }, // 1409..
    { key: "filter", base: 1536 },   // 1537..
    { key: "lfo", base: 1664 },      // 1665..
    { key: "env", base: 1792 },      // 1793..
    { key: "cords", base: 1920 },    // 1921..
  ];
  // Section sizes of a Proteus 2000 dump. The P2K reports 52 common-general
  // params (Ctrl M-P only exist on the 2500, which reports 56). The envelope
  // count includes an unused id (1832).
  const DEFAULT_COUNTS = {
    general: 52, arp: 19, fx: 16, link: 20, layers: 4,
    lgeneral: 31, filter: 3, lfo: 10, env: 42, cords: 72,
  };
  const NAME_LEN = 16;
  const PACKET_DATA = 244;

  /* ---------------------------- numbers ---------------------------------- */
  function enc14(v) {
    v = Math.round(v);
    if (v < 0) v += 16384;
    return [v & 0x7f, (v >> 7) & 0x7f];
  }
  function dec14(lsb, msb) {
    const v = (lsb & 0x7f) | ((msb & 0x7f) << 7);
    return v >= 8192 ? v - 16384 : v;
  }
  const decU14 = (lsb, msb) => (lsb & 0x7f) | ((msb & 0x7f) << 7);
  // 1's complement of the 7-bit sum of the data bytes.
  function checksum(bytes, from, to) {
    let s = 0;
    for (let i = from; i < to; i++) s += bytes[i];
    return ~s & 0x7f;
  }

  /* ---------------------------- messages --------------------------------- */
  function msg(dev, cmd, body) {
    return new Uint8Array([0xf0, EMU, PROTEUS, dev & 0x7f, EDITOR, cmd, ...(body || []), 0xf7]);
  }

  // pairs: [[id, value], ...]. Byte count = number of 2-byte pairs (id + value each = 2).
  function paramEdit(dev, pairs) {
    const body = [pairs.length * 2];
    for (const [id, v] of pairs) body.push(...enc14(id), ...enc14(v));
    return msg(dev, CMD.PARAM_EDIT, body);
  }
  function paramRequest(dev, ids) {
    const body = [ids.length];
    for (const id of ids) body.push(...enc14(id));
    return msg(dev, CMD.PARAM_REQ, body);
  }
  // closed = true asks for a handshaked (ACK per packet) dump.
  function presetDumpRequest(dev, number, romId, closed) {
    return msg(dev, CMD.PRESET_DUMP_REQ, [closed ? 0x02 : 0x04, ...enc14(number), ...enc14(romId)]);
  }
  function nameRequest(dev, objType, number, romId) {
    return msg(dev, CMD.NAME_REQ, [objType, ...enc14(number), ...enc14(romId)]);
  }
  const configRequest = (dev) => msg(dev, CMD.CONFIG_REQ);
  const ack = (dev, packet) => msg(dev, CMD.ACK, enc14(packet));
  const nak = (dev, packet) => msg(dev, CMD.NAK, enc14(packet));
  const eof = (dev) => msg(dev, CMD.EOF);
  const cancel = (dev) => msg(dev, CMD.CANCEL);
  const deviceInquiry = () => new Uint8Array([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);

  /* ---------------------------- classify --------------------------------- */
  // bytes -> { type, ... } or null for anything that isn't Proteus SysEx.
  function classify(d) {
    if (!d || d.length < 6 || d[0] !== 0xf0 || d[d.length - 1] !== 0xf7) return null;
    if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x02 && d.length >= 15) {
      return {
        type: "identity", dev: d[2], manufacturer: d[5],
        family: decU14(d[6], d[7]), member: decU14(d[8], d[9]),
        version: String.fromCharCode(d[10], d[11], d[12], d[13]),
      };
    }
    if (d[1] !== EMU || d[2] !== PROTEUS || d[4] !== EDITOR || d.length < 7) return null;
    const dev = d[3], cmd = d[5];
    switch (cmd) {
      case CMD.PARAM_EDIT: {
        const params = [];
        const n = d[6] >> 1;
        for (let i = 0; i < n; i++) {
          const o = 7 + i * 4;
          if (o + 3 >= d.length - 1) break;
          params.push([decU14(d[o], d[o + 1]), dec14(d[o + 2], d[o + 3])]);
        }
        return { type: "param", dev, params };
      }
      case CMD.CONFIG: {
        const nGen = d[6];
        const userPresets = nGen >= 2 ? decU14(d[7], d[8]) : 0;
        const nSimms = d[7 + nGen], per = d[8 + nGen];
        const simms = [];
        for (let i = 0; i < nSimms; i++) {
          const o = 9 + nGen + i * per;
          if (o + 1 >= d.length - 1) break;
          simms.push({
            id: decU14(d[o], d[o + 1]),
            presets: per >= 4 ? decU14(d[o + 2], d[o + 3]) : 0,
            instruments: per >= 6 ? decU14(d[o + 4], d[o + 5]) : 0,
          });
        }
        return { type: "config", dev, userPresets, simms };
      }
      case CMD.NAME: {
        let name = "";
        for (let i = 11; i < d.length - 1 && name.length < 16; i++) name += String.fromCharCode(d[i]);
        return {
          type: "name", dev, objType: d[6],
          number: decU14(d[7], d[8]), romId: decU14(d[9], d[10]), name,
        };
      }
      case CMD.PRESET_DUMP: {
        const sub = d[6];
        if (sub === 0x01 || sub === 0x03) {
          const w = (k) => decU14(d[k], d[k + 1]);
          return {
            type: "dumpHeader", dev, closed: sub === 0x01,
            number: dec14(d[7], d[8]),
            bytes: d[9] | (d[10] << 7) | (d[11] << 14) | (d[12] << 21),
            counts: {
              general: w(13), arp: w(15), fx: w(17), link: w(19), layers: w(21),
              lgeneral: w(23), filter: w(25), lfo: w(27), env: w(29), cords: w(31),
            },
            romId: w(33),
          };
        }
        if (sub === 0x02 || sub === 0x04) {
          const data = d.slice(9, d.length - 2);
          const ck = d[d.length - 2];
          return {
            type: "dumpData", dev, closed: sub === 0x02,
            packet: decU14(d[7], d[8]), data,
            checksumOk: ck === 0x7f || ck === checksum(d, 9, d.length - 2),
          };
        }
        return { type: "presetPart", dev, sub };
      }
      case CMD.SETUP_DUMP:
        return { type: "setup", dev, bytes: d };
      case CMD.ERROR:
        return { type: "error", dev, cmd: decU14(d[6], d[7]), sub: decU14(d[8], d[9]) };
      case CMD.ACK: return { type: "ack", dev, packet: decU14(d[6], d[7]) };
      case CMD.NAK: return { type: "nak", dev, packet: decU14(d[6], d[7]) };
      case CMD.EOF: return { type: "eof", dev };
      case CMD.WAIT: return { type: "wait", dev };
      case CMD.CANCEL: return { type: "cancel", dev };
      default: return { type: "unknown", dev, cmd };
    }
  }

  /* ---------------------------- presets ---------------------------------- */
  function dataLength(c) {
    const common = c.general + c.arp + c.fx + c.link;
    const layer = c.lgeneral + c.filter + c.lfo + c.env + c.cords;
    return NAME_LEN + 2 * (common + c.layers * layer);
  }

  // Decode the concatenated data bytes of a preset dump, laid out per the header counts.
  function decodePreset(counts, data) {
    const c = Object.assign({}, counts);
    if (data.length < dataLength(c)) throw new Error("preset dump too short: " + data.length + " < " + dataLength(c));
    let name = "";
    for (let i = 0; i < NAME_LEN; i++) name += String.fromCharCode(data[i] & 0x7f);
    let o = NAME_LEN;
    const read = (target, base, n) => {
      for (let i = 0; i < n; i++, o += 2) target[base + 1 + i] = dec14(data[o], data[o + 1]);
    };
    const common = {};
    for (const s of COMMON_SECTIONS) read(common, s.base, c[s.key]);
    const layers = [];
    for (let l = 0; l < c.layers; l++) {
      const L = {};
      for (const s of LAYER_SECTIONS) read(L, s.base, c[s.key]);
      layers.push(L);
    }
    return { name, common, layers, counts: c };
  }

  function encodePresetData(p) {
    const c = p.counts || DEFAULT_COUNTS;
    const out = new Uint8Array(dataLength(c));
    const nm = (p.name || "").padEnd(NAME_LEN).slice(0, NAME_LEN);
    for (let i = 0; i < NAME_LEN; i++) out[i] = nm.charCodeAt(i) & 0x7f;
    let o = NAME_LEN;
    const write = (src, base, n) => {
      for (let i = 0; i < n; i++, o += 2) {
        const [lo, hi] = enc14((src && src[base + 1 + i]) | 0);
        out[o] = lo; out[o + 1] = hi;
      }
    };
    for (const s of COMMON_SECTIONS) write(p.common, s.base, c[s.key]);
    for (let l = 0; l < c.layers; l++) {
      for (const s of LAYER_SECTIONS) write(p.layers[l], s.base, c[s.key]);
    }
    return out;
  }

  // -> [header, packet 1, ..., packet n]. number -1 = edit buffer; romId 0 = user.
  function encodePreset(p, { dev = 0, number = EDIT_BUFFER, romId = 0, closed = false } = {}) {
    const c = p.counts || DEFAULT_COUNTS;
    const data = encodePresetData(p);
    const n = data.length;
    const hdr = [closed ? 0x01 : 0x03, ...enc14(number),
      n & 0x7f, (n >> 7) & 0x7f, (n >> 14) & 0x7f, (n >> 21) & 0x7f];
    for (const k of ["general", "arp", "fx", "link", "layers", "lgeneral", "filter", "lfo", "env", "cords"]) {
      hdr.push(...enc14(c[k]));
    }
    hdr.push(...enc14(romId));
    const msgs = [msg(dev, CMD.PRESET_DUMP, hdr)];
    for (let off = 0, pkt = 1; off < n; off += PACKET_DATA, pkt++) {
      const chunk = data.subarray(off, Math.min(n, off + PACKET_DATA));
      const m = new Uint8Array(11 + chunk.length);
      m.set([0xf0, EMU, PROTEUS, dev & 0x7f, EDITOR, CMD.PRESET_DUMP, closed ? 0x02 : 0x04, ...enc14(pkt)]);
      m.set(chunk, 9);
      m[m.length - 2] = checksum(m, 9, m.length - 2);
      m[m.length - 1] = 0xf7;
      msgs.push(m);
    }
    return msgs;
  }

  // Collects a header + data packets into a preset. feed() returns
  //   { ack: packetNo }       closed-loop: acknowledge this packet
  //   { nak: packetNo }       checksum failed
  //   { done: true, preset, number, romId }
  //   null                    not part of a dump in progress
  // Packets are keyed by number, so a resent packet replaces its first copy.
  function PresetAssembler() {
    let hdr = null, parts = null;
    const total = () => { let n = 0; for (const d of parts.values()) n += d.length; return n; };
    return {
      get busy() { return !!hdr; },
      reset() { hdr = null; parts = null; },
      feed(m) {
        if (!m) return null;
        if (m.type === "dumpHeader") {
          hdr = m; parts = new Map();
          return m.closed ? { ack: 0 } : { started: true };
        }
        if (m.type !== "dumpData" || !hdr) return null;
        if (!m.checksumOk) return { nak: m.packet };
        parts.set(m.packet, m.data);
        const res = m.closed ? { ack: m.packet } : {};
        if (total() >= hdr.bytes) {
          const ordered = [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k));
          res.done = true;
          res.preset = decodePreset(hdr.counts, concat(ordered));
          res.number = hdr.number;
          res.romId = hdr.romId;
          hdr = null; parts = null;
        }
        return res;
      },
    };
  }

  /* ---------------------------- setups --------------------------------- */
  // A setup dump (1Ch) is one message: 7 section counts, the 16-char name, then
  // params in id order per section (master general, master MIDI, master FX,
  // master arp - the spec's "reserved" -, non-channel), then each channel's.
  // Which ids a section skips isn't spelled out. The spec's content list gives
  // general 257-260, 264.. (prodatum agrees) and MIDI 385, 386, 388, 391..;
  // prodatum's code counts the MIDI section without gaps. decodeSetup tries
  // both and keeps the one whose SysEx ID (388) matches the unit that sent it.
  const SETUP_COUNTS_KEYS = ["general", "midi", "fx", "arp", "nonChannel", "channels", "perChannel"];
  const DEFAULT_SETUP_COUNTS = { general: 19, midi: 22, fx: 16, arp: 21, nonChannel: 3, channels: 32, perChannel: 9 };
  const idSeq = (start, skip) => (n) => {
    const ids = [];
    for (let id = start; ids.length < n; id++) if (!skip.includes(id)) ids.push(id);
    return ids;
  };
  const SETUP_LAYOUTS = [
    { name: "spec", general: idSeq(257, [261, 262, 263]), midi: idSeq(385, [387, 389, 390]) },
    { name: "MIDI without gaps", general: idSeq(257, [261, 262, 263]), midi: idSeq(385, []) },
  ];
  function setupSections(layout, c) {
    return [
      layout.general(c.general), layout.midi(c.midi),
      idSeq(513, [])(c.fx), idSeq(641, [])(c.arp), idSeq(139, [])(c.nonChannel),
    ];
  }
  const setupBytes = (c) => 36 + 2 * (c.general + c.midi + c.fx + c.arp + c.nonChannel + c.channels * c.perChannel) + 1;

  const setupDumpRequest = (dev) => msg(dev, CMD.SETUP_DUMP_REQ);
  // src/dst: setup number 0..127, or -1 for the current setup (one of them must be -1).
  const copySetup = (dev, src, dst) => msg(dev, CMD.COPY_SETUP, [...enc14(src), ...enc14(dst)]);

  function decodeSetupWith(d, layout, c) {
    let o = 36;
    const common = {};
    for (const ids of setupSections(layout, c)) {
      for (const id of ids) { common[id] = dec14(d[o], d[o + 1]); o += 2; }
    }
    const channels = [];
    for (let ch = 0; ch < c.channels; ch++) {
      const p = {};
      for (const id of idSeq(130, [])(c.perChannel)) { p[id] = dec14(d[o], d[o + 1]); o += 2; }
      channels.push(p);
    }
    return { common, channels };
  }

  // A decode is plausible when the SysEx ID matches the unit's and the MIDI
  // section's values sit in their own ranges (a shifted reading puts knob CCs
  // where the footswitch CCs, 64-79, and knobs I-L, 70-95, belong).
  function plausibleSetup(common, dev) {
    const within = (id, lo, hi) => common[id] === undefined || (common[id] >= lo && common[id] <= hi);
    return common[388] === dev && within(385, 0, 2) &&
      [399, 400, 401].every((id) => within(id, 64, 79)) && [406, 407, 408, 409].every((id) => within(id, 70, 95));
  }

  // -> { dev, name, counts, common, channels, layout, verified }
  function decodeSetup(d) {
    const w = (k) => decU14(d[k], d[k + 1]);
    const c = {};
    SETUP_COUNTS_KEYS.forEach((k, i) => { c[k] = w(6 + i * 2); });
    if (d.length < setupBytes(c)) throw new Error("setup dump too short: " + d.length + " < " + setupBytes(c));
    let name = "";
    for (let i = 20; i < 36; i++) name += String.fromCharCode(d[i] & 0x7f);
    const dev = d[3];
    let fallback = null;
    for (const layout of SETUP_LAYOUTS) {
      const r = decodeSetupWith(d, layout, c);
      if (plausibleSetup(r.common, dev)) return Object.assign({ dev, name, counts: c, layout: layout.name, verified: true }, r);
      if (!fallback) fallback = Object.assign({ dev, name, counts: c, layout: layout.name, verified: false }, r);
    }
    return fallback;
  }

  function encodeSetup(s, { dev = 0, layout = SETUP_LAYOUTS[0] } = {}) {
    const c = Object.assign({}, DEFAULT_SETUP_COUNTS, s.counts || {});
    const out = [0xf0, EMU, PROTEUS, dev & 0x7f, EDITOR, CMD.SETUP_DUMP];
    for (const k of SETUP_COUNTS_KEYS) out.push(...enc14(c[k]));
    const nm = (s.name || "").padEnd(16).slice(0, 16);
    for (let i = 0; i < 16; i++) out.push(nm.charCodeAt(i) & 0x7f);
    for (const ids of setupSections(layout, c)) for (const id of ids) out.push(...enc14((s.common && s.common[id]) | 0));
    for (let ch = 0; ch < c.channels; ch++) {
      for (const id of idSeq(130, [])(c.perChannel)) out.push(...enc14((s.channels && s.channels[ch] && s.channels[ch][id]) | 0));
    }
    out.push(0xf7);
    return new Uint8Array(out);
  }

  /* ---------------------------- files ------------------------------------ */
  // Split a byte stream (a .syx file) into individual SysEx messages.
  function splitSysex(bytes) {
    const out = [];
    let start = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xf0) start = i;
      else if (bytes[i] === 0xf7 && start >= 0) { out.push(bytes.slice(start, i + 1)); start = -1; }
    }
    return out;
  }

  // All presets in a file -> [{ preset, number, romId }].
  function presetsFromSysex(bytes) {
    const asm = PresetAssembler(), found = [];
    for (const m of splitSysex(bytes)) {
      const r = asm.feed(classify(m));
      if (r && r.done) found.push({ preset: r.preset, number: r.number, romId: r.romId });
    }
    return found;
  }

  function concat(msgs) {
    const n = msgs.reduce((a, m) => a + m.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const m of msgs) { out.set(m, o); o += m.length; }
    return out;
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }
  function fromHex(s) {
    return new Uint8Array(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
  }

  function clonePreset(p) {
    return {
      name: p.name,
      common: Object.assign({}, p.common),
      layers: p.layers.map((l) => Object.assign({}, l)),
      counts: Object.assign({}, p.counts || DEFAULT_COUNTS),
    };
  }

  return {
    CMD, OBJ, EDIT_BUFFER, DEFAULT_COUNTS, COMMON_SECTIONS, LAYER_SECTIONS, NAME_LEN, PACKET_DATA,
    enc14, dec14, decU14, checksum,
    msg, paramEdit, paramRequest, presetDumpRequest, nameRequest, configRequest,
    ack, nak, eof, cancel, deviceInquiry,
    classify, dataLength, decodePreset, encodePresetData, encodePreset, PresetAssembler,
    splitSysex, presetsFromSysex, concat, hex, fromHex, clonePreset,
    DEFAULT_SETUP_COUNTS, SETUP_LAYOUTS, setupDumpRequest, copySetup, decodeSetup, encodeSetup,
  };
})();
