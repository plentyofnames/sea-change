"use strict";
/* ============================================================================
 * presets — the Presets tab: pick a ROM, hit a bank, click a preset by name.
 * Sends Bank Select MSB (ROM id), LSB (bank) and Program Change in one go.
 * User banks show the names read from the unit (UserNames), once read.
 * Double-click a preset to open it in the editor.
 * ==========================================================================*/
const Presets = (() => {
  const $rom = document.getElementById("rom");
  const $search = document.getElementById("search");
  const $type = document.getElementById("type");
  const $clear = document.getElementById("clear");
  const $readNames = document.getElementById("read-names");
  const $banks = document.getElementById("banks");
  const $presets = document.getElementById("presets");
  const $results = document.getElementById("results");

  const USER = { id: "USER", name: "User", msb: 0, user: true, banks: [0, 1, 2, 3] };
  const ROMS = [...P2K_ROMS, USER];

  const TYPES = [
    { label: "Bass",                codes: ["bas", "bs1", "bs2", "bs3", "bs4", "bs5", "sub"] },
    { label: "Keys & Organ",        codes: ["kb1", "kb2", "kb3", "kb4", "key", "org"] },
    { label: "Synth",               codes: ["syn", "wav", "tec"] },
    { label: "Lead",                codes: ["led"] },
    { label: "Pad",                 codes: ["pad"] },
    { label: "Ambient",             codes: ["amb"] },
    { label: "Arpeggio",            codes: ["arp"] },
    { label: "Tempo-synced",        codes: ["bpm", "clk"] },
    { label: "Strings & Orchestra", codes: ["str", "orc"] },
    { label: "Brass & Wind",        codes: ["brs", "wnd"] },
    { label: "Guitar",              codes: ["gtr", "git"] },
    { label: "Vocals",              codes: ["vox"] },
    { label: "Hits",                codes: ["hit"] },
    { label: "Beats",               codes: ["bts"] },
    { label: "Drum kits",           codes: ["kit"] },
    { label: "Percussion",          codes: ["prc", "pr1", "pr2", "pr3"] },
    { label: "Single drums",        codes: ["bd1", "bd2", "sn1", "sn2", "sn3", "sn4", "sn5", "sn6", "sn7", "hh1", "cb1", "cb2", "clp", "tom"] },
    { label: "FX, Noise & Scratch", codes: ["sfx", "nse", "scr"] },
  ];

  let romIdx = 0;
  let bankIdx = 0;
  let active = null; // { rom, bank, pc } of the last preset sent

  function splitPreset(s) {
    const i = s.indexOf(":");
    return i < 0 ? { cat: "", name: s.trim() } : { cat: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
  }

  // Name of a preset: ROM names are built in, user names come from the unit.
  function presetLabel(r, b, pc) {
    const rom = ROMS[r];
    return rom.user ? UserNames.get(b * 128 + pc) : rom.banks[b][pc];
  }

  // Search index. User presets join it once their names have been read.
  let INDEX = [];
  function buildIndex() {
    INDEX = [];
    ROMS.forEach((rom, r) => {
      rom.banks.forEach((_, b) => {
        for (let pc = 0; pc < 128; pc++) {
          const label = presetLabel(r, b, pc);
          if (!label) continue;
          const { cat, name } = splitPreset(label);
          INDEX.push({ r, b, pc, cat, hay: (cat + " " + name).toLowerCase() });
        }
      });
    });
  }
  buildIndex();

  const grouped = new Set(TYPES.flatMap((t) => t.codes));
  const otherCodes = [...new Set(INDEX.map((e) => e.cat))].filter((c) => !grouped.has(c));
  if (otherCodes.length) TYPES.push({ label: "Other", codes: otherCodes });

  ROMS.forEach((rom, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = rom.user
      ? "User banks (MSB 0)"
      : rom.name + " — " + rom.id + " (MSB " + rom.msb + ")";
    $rom.appendChild(opt);
  });

  TYPES.forEach((t, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = t.label + " (" + INDEX.filter((e) => t.codes.includes(e.cat)).length + ")";
    opt.title = t.codes.map((c) => c || "(none)").join(" ");
    $type.appendChild(opt);
  });

  // Numbered variants (bs1…bs5, kb1…kb4) share a hue.
  function catColor(cat) {
    const key = cat.replace(/\d+$/, "");
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return "hsl(" + h + ", 55%, 68%)";
  }

  function bankCategories(r, b) {
    const seen = [];
    for (let pc = 0; pc < 128; pc++) {
      const label = presetLabel(r, b, pc);
      const c = label && splitPreset(label).cat;
      if (c && !seen.includes(c)) seen.push(c);
    }
    return seen;
  }

  function isActive(r, b, pc) {
    return active && active.rom === r && active.bank === b && (pc === undefined || active.pc === pc);
  }

  function isSearching() {
    return $search.value.trim() !== "" || $type.value !== "";
  }

  function render() {
    renderBanks();
    const searching = isSearching();
    $presets.hidden = searching;
    $results.hidden = !searching;
    $clear.hidden = !searching;
    $readNames.hidden = !ROMS[romIdx].user || searching;
    if (searching) renderResults(); else renderPresets();
  }

  function clearSearch() {
    $search.value = "";
    $type.value = "";
    render();
  }

  function renderBanks() {
    const rom = ROMS[romIdx];
    $banks.innerHTML = "";
    rom.banks.forEach((bank, b) => {
      const btn = document.createElement("button");
      btn.className = "bank-btn" + (b === bankIdx ? " selected" : "") + (isActive(romIdx, b) ? " has-active" : "");

      const title = document.createElement("div");
      title.className = "title";
      title.append("Bank " + b);
      const msb = document.createElement("span");
      msb.className = "msb";
      msb.textContent = rom.msb + "/" + b;
      title.appendChild(msb);

      const cats = document.createElement("div");
      cats.className = "cats";
      const list = bankCategories(romIdx, b);
      if (rom.user && !list.length) {
        cats.textContent = "user · " + (b * 128) + "–" + (b * 128 + 127);
      } else {
        cats.textContent = list.slice(0, 6).join(" · ") + (list.length > 6 ? " …" : "");
        cats.title = list.join(" · ");
      }

      btn.append(title, cats);
      btn.addEventListener("click", () => { bankIdx = b; clearSearch(); });
      $banks.appendChild(btn);
    });
  }

  function presetButton(r, b, pc, numText) {
    const rom = ROMS[r];
    const btn = document.createElement("button");
    btn.className = "preset" + (isActive(r, b, pc) ? " active" : "");
    btn.addEventListener("click", () => sendPreset(r, b, pc));
    btn.addEventListener("dblclick", () => {
      document.dispatchEvent(new CustomEvent("p2k:edit-request"));
    });

    const label = presetLabel(r, b, pc);
    if (!label) {
      btn.classList.add("numonly");
      btn.textContent = String(pc);
      btn.title = "User bank " + b + " #" + pc + " · double-click to edit";
      return btn;
    }

    const { cat, name } = splitPreset(label);
    btn.title = rom.id + " bank " + b + " #" + pc + "  " + cat + ":" + name + " · double-click to edit";
    const num = document.createElement("span");
    num.className = "num" + (numText.length > 3 ? " wide" : "");
    num.textContent = numText;
    const c = document.createElement("span");
    c.className = "cat";
    c.textContent = cat;
    c.style.color = catColor(cat);
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    btn.append(num, c, n);
    return btn;
  }

  function renderPresets() {
    $presets.innerHTML = "";
    for (let pc = 0; pc < 128; pc++) {
      $presets.appendChild(presetButton(romIdx, bankIdx, pc, String(pc)));
    }
  }

  function renderResults() {
    const tokens = $search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const type = $type.value === "" ? null : TYPES[parseInt($type.value, 10)];
    const hits = INDEX.filter((e) =>
      (!type || type.codes.includes(e.cat)) && tokens.every((t) => e.hay.includes(t)));

    const perRom = new Map();
    for (const e of hits) perRom.set(e.r, (perRom.get(e.r) || 0) + 1);

    $results.innerHTML = "";
    const summary = document.createElement("div");
    summary.className = "results-summary";
    summary.textContent = hits.length
      ? hits.length + (hits.length === 1 ? " match" : " matches") + " · click to send · double-click to edit · Esc to clear"
      : "No presets match.";
    $results.appendChild(summary);

    let grid = null;
    let lastRom = -1;
    for (const e of hits) {
      if (e.r !== lastRom) {
        lastRom = e.r;
        const h = document.createElement("h2");
        h.textContent = ROMS[e.r].name + " · " + ROMS[e.r].id + " · " + perRom.get(e.r);
        grid = document.createElement("div");
        grid.className = "result-grid";
        $results.append(h, grid);
      }
      grid.appendChild(presetButton(e.r, e.b, e.pc, e.b + "·" + e.pc));
    }
  }

  function sendPreset(r, b, pc) {
    const out = Midi.output;
    if (!out) { setStatus("No MIDI output selected", "err"); return; }

    const rom = ROMS[r];
    const ch = Midi.channel;
    if (!Midi.sendNow([0xB0 | ch, 0, rom.msb]) || // CC 0  — Bank Select MSB (ROM ID, 0 = User)
        !Midi.sendNow([0xB0 | ch, 32, b]) ||      // CC 32 — Bank Select LSB (bank in ROM)
        !Midi.sendNow([0xC0 | ch, pc])) return;   // Program Change

    // Follow the sent preset so the bank view shows where it lives.
    active = { rom: r, bank: b, pc };
    romIdx = r;
    bankIdx = b;
    $rom.value = String(r);
    render();

    const name = presetLabel(r, b, pc);
    setStatus(rom.id + " bank " + b + " #" + pc + (name ? " " + name : "") +
      " (MSB " + rom.msb + ", LSB " + b + ", PC " + pc + ") ch " + (ch + 1) + " → " + out.name, "ok");
    document.dispatchEvent(new CustomEvent("p2k:preset-selected", {
      detail: { romId: rom.msb, number: b * 128 + pc, name },
    }));
  }

  // The editor stored or selected a preset: mark it like a click here would.
  function markActive(romId, number) {
    const r = ROMS.findIndex((x) => x.msb === romId);
    if (r < 0) return;
    active = { rom: r, bank: number >> 7, pc: number & 127 };
    render();
  }

  async function readNames() {
    if (UserNames.scanning) { UserNames.scan(); return; }   // second click cancels
    $readNames.textContent = "Stop reading";
    try {
      const ok = await UserNames.scan({
        onProgress: (i, n) => setStatus("Reading user preset names " + i + "/" + n + "…"),
      });
      if (ok) setStatus("Read all " + UserNames.COUNT + " user preset names.", "ok");
      else setStatus("Stopped reading user preset names.");
    } catch (e) {
      setStatus(e.message + ". Check the MIDI input and the P2K's SysEx ID.", "err");
    } finally {
      $readNames.textContent = "Read names from P2K";
    }
  }

  $rom.addEventListener("change", () => {
    romIdx = parseInt($rom.value, 10);
    bankIdx = Math.min(bankIdx, ROMS[romIdx].banks.length - 1);
    clearSearch();
  });
  $search.addEventListener("input", render);
  $type.addEventListener("change", render);
  $clear.addEventListener("click", clearSearch);
  $readNames.addEventListener("click", readNames);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isSearching() && !document.getElementById("view-presets").hidden) {
      e.preventDefault();
      clearSearch();
    }
  });
  UserNames.subscribe(() => { buildIndex(); render(); });

  render();

  return { markActive, presetLabel: (romId, number) => {
    const r = ROMS.findIndex((x) => x.msb === romId);
    return r < 0 ? "" : presetLabel(r, number >> 7, number & 127) || "";
  } };
})();
