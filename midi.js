"use strict";
/* ============================================================================
 * midi — the one place bytes enter and leave; shared by both tabs.
 *
 *   setStatus  the footer status line.
 *   Midi       Web MIDI access, port / channel / SysEx-ID selection (remembered),
 *              one paced send queue with per-key trailing coalescing (slider
 *              drags collapse, so the P2K never sees a flood of edits: it
 *              answers those with "Sysex too fast"), listeners for incoming
 *              SysEx. Access starts without SysEx permission (the preset
 *              selector doesn't need it); SysEx is enabled on first use.
 *   UserNames  user preset names read from the unit (Generic Name Request),
 *              cached in localStorage.
 * ==========================================================================*/

function setStatus(msg, kind = "") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

const Midi = (() => {
  const $ = (id) => document.getElementById(id);
  const $out = $("port"), $in = $("inport"), $channel = $("channel"), $dev = $("devid");

  // localStorage is shared by every app on the origin, hence the prefixed key.
  const STORE_KEY = "sea-change:settings";
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  })();
  // The ports the user last picked. Port ids can change between sessions, so the name is the fallback.
  let preferredOut = saved.port || null;
  let preferredIn = saved.input || null;

  let access = null, sysex = false;
  const listeners = new Set();

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        port: preferredOut, input: preferredIn,
        channel: parseInt($channel.value, 10), devId: parseInt($dev.value, 10),
      }));
    } catch { /* storage unavailable: settings just aren't remembered */ }
  }

  function fillPorts($sel, ports, preferred, noneText) {
    const prev = $sel.value;
    $sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = noneText;
    $sel.appendChild(none);
    for (const p of ports) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name + (p.manufacturer ? " (" + p.manufacturer + ")" : "");
      $sel.appendChild(opt);
    }
    const pref = preferred && (ports.find((p) => p.id === preferred.id) || ports.find((p) => p.name === preferred.name));
    const pick = pref || ports.find((p) => p.id === prev);
    $sel.value = pick ? pick.id : "";
    return !!pref;
  }

  // Returns true if the preferred output is connected (and now selected).
  function refreshPorts() {
    if (!access) return false;
    const outs = [...access.outputs.values()], ins = [...access.inputs.values()];
    const foundOut = fillPorts($out, outs, preferredOut, outs.length ? "— None —" : "— No MIDI outputs found —");
    // Saved output missing: use the first one for now; the saved one is picked up when it appears.
    if (!$out.value && outs.length) $out.value = outs[0].id;
    // With no saved input, take the input named like the output: interfaces name both ends alike.
    const outName = output() && output().name;
    fillPorts($in, ins, preferredIn || (outName ? { id: "", name: outName } : null),
      ins.length ? "— None —" : "— No MIDI inputs found —");
    bindInput();
    return foundOut;
  }

  function output() { return access ? access.outputs.get($out.value) || null : null; }
  function input() { return access ? access.inputs.get($in.value) || null : null; }

  let boundIn = null;
  function bindInput() {
    if (boundIn) boundIn.onmidimessage = null;
    boundIn = input();
    if (boundIn) boundIn.onmidimessage = onMessage;
  }

  function onMessage(e) {
    const d = e.data;
    if (d[0] !== 0xf0) return;
    const m = P2KC.classify(d);
    if (!m) return;
    if (m.type === "error") console.warn("P2K error message", m);
    for (const fn of [...listeners]) fn(m, d);
  }

  // Resolves to true once SysEx access is granted (asks the browser on first use).
  async function enableSysex() {
    if (sysex) return true;
    if (!navigator.requestMIDIAccess) return false;
    try {
      const a = await navigator.requestMIDIAccess({ sysex: true });
      if (access) access.onstatechange = null;
      access = a;
      sysex = true;
      access.onstatechange = () => refreshPorts();
      refreshPorts();
      return true;
    } catch (err) {
      setStatus("SysEx access denied: " + err.message + ". The editor needs it; allow MIDI SysEx for this site.", "err");
      return false;
    }
  }

  /* -------------------------- paced queue -------------------------------- */
  // An item is a list of messages (or a function returning one, evaluated when
  // it's sent) followed by `gap` ms of silence. A queued item with the same key
  // is updated in place instead of queueing another.
  const queue = [], pending = new Map();
  let timer = null, idleWaiters = [];

  function enqueue(msgs, { gap = 20, key } = {}) {
    if (!output()) return false;
    if (key && pending.has(key)) { pending.get(key).msgs = msgs; return true; }
    const item = { msgs, gap, key };
    queue.push(item);
    if (key) pending.set(key, item);
    if (!timer) pump();
    return true;
  }

  function pump() {
    const item = queue.shift();
    if (!item) {
      timer = null;
      const w = idleWaiters; idleWaiters = [];
      w.forEach((fn) => fn());
      return;
    }
    if (item.key) pending.delete(item.key);
    const msgs = typeof item.msgs === "function" ? item.msgs() : item.msgs;
    const out = output();
    try { if (out) for (const m of msgs) out.send(m); } catch (e) { setStatus("MIDI send failed: " + e.message, "err"); }
    timer = setTimeout(pump, item.gap);
  }

  // Resolves when everything queued has gone out.
  const idle = () => (timer || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

  // Bypasses the queue: notes, program changes, dump handshakes.
  function sendNow(bytes) {
    const out = output();
    if (!out) return false;
    try { out.send(bytes); return true; } catch (e) { setStatus("MIDI send failed: " + e.message, "err"); return false; }
  }

  function listen(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Resolves with the first incoming message for which match(m) is truthy.
  function waitFor(match, ms, what) {
    return new Promise((resolve, reject) => {
      const off = listen((m) => {
        if (!match(m)) return;
        clearTimeout(t); off(); resolve(m);
      });
      const t = setTimeout(() => { off(); reject(new Error("No answer from the P2K" + (what ? " (" + what + ")" : ""))); }, ms);
    });
  }

  /* -------------------------- init -------------------------------------- */
  for (let i = 1; i <= 16; i++) {
    const opt = document.createElement("option");
    opt.value = String(i - 1);
    opt.textContent = String(i);
    $channel.appendChild(opt);
  }
  for (let i = 0; i <= 126; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    $dev.appendChild(opt);
  }
  $channel.value = String(Math.max(0, Math.min(15, saved.channel | 0)));
  $dev.value = String(Math.max(0, Math.min(126, saved.devId | 0)));

  $out.addEventListener("change", () => {
    const out = output();
    preferredOut = out ? { id: out.id, name: out.name } : null;
    saveSettings();
  });
  $in.addEventListener("change", () => {
    const inp = input();
    preferredIn = inp ? { id: inp.id, name: inp.name } : null;
    bindInput();
    saveSettings();
  });
  $channel.addEventListener("change", saveSettings);
  $dev.addEventListener("change", saveSettings);

  async function init() {
    if (!navigator.requestMIDIAccess) {
      setStatus("Web MIDI not supported in this browser. Use Chrome, Edge, Opera or Firefox 108+ (Safari has no Web MIDI).", "err");
      return;
    }
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      setStatus("MIDI access denied: " + err.message, "err");
      return;
    }
    const foundPreferred = refreshPorts();
    access.onstatechange = () => {
      refreshPorts();
      setStatus("MIDI ports updated. Output: " + outputName());
    };
    if (access.outputs.size === 0) {
      setStatus("MIDI ready, but no outputs are connected.", "err");
    } else if (preferredOut && !foundPreferred) {
      setStatus('Saved output "' + preferredOut.name + '" is not connected. Using ' + outputName() + " for now.", "err");
    } else {
      setStatus("Ready. Output: " + outputName(), "ok");
    }
  }

  const outputName = () => (output() ? output().name : "—");

  return {
    init, enableSysex, enqueue, idle, sendNow, listen, waitFor, outputName,
    get output() { return output(); },
    get input() { return input(); },
    get sysex() { return sysex; },
    get channel() { return parseInt($channel.value, 10) & 0x0f; },
    get devId() { return parseInt($dev.value, 10) & 0x7f; },
  };
})();

/* ---------------------------- user names --------------------------------- */
const UserNames = (() => {
  const KEY = "sea-change:user-names";
  const COUNT = 512;  // 4 user banks x 128
  let names = (() => {
    try {
      const a = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(a) && a.length === COUNT ? a : Array(COUNT).fill("");
    } catch { return Array(COUNT).fill(""); }
  })();
  const subs = new Set();
  let scanning = null;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(names)); } catch { /* not remembered */ }
  }
  function changed() { save(); subs.forEach((fn) => fn()); }

  function set(n, name) { if (n >= 0 && n < COUNT) { names[n] = name; changed(); } }

  // Reads all user preset names (or `count` from `from`). One request at a time:
  // each answer triggers the next.
  async function scan({ from = 0, count = COUNT, onProgress } = {}) {
    if (scanning) { scanning.cancelled = true; return false; }
    if (!(await Midi.enableSysex())) return false;
    if (!Midi.output || !Midi.input) {
      setStatus("Reading names needs both a MIDI output and the MIDI input the P2K's MIDI Out is connected to.", "err");
      return false;
    }
    const job = { cancelled: false };
    scanning = job;
    let got = 0;
    try {
      for (let n = from; n < from + count && !job.cancelled; n++) {
        Midi.sendNow(P2KC.nameRequest(Midi.devId, P2KC.OBJ.PRESET, n, 0));
        // Requests go one at a time, so the next preset-name answer is this one's.
        const m = await Midi.waitFor((x) => x.type === "name" && x.objType === P2KC.OBJ.PRESET, 1500, "preset name");
        names[n] = m.name;
        got++;
        if (onProgress) onProgress(n - from + 1, count);
        if (got % 32 === 0) changed();
      }
      return !job.cancelled;
    } finally {
      scanning = null;
      changed();
    }
  }

  return {
    COUNT, scan, set,
    get: (n) => names[n] || "",
    get scanning() { return !!scanning; },
    get any() { return names.some(Boolean); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
})();
