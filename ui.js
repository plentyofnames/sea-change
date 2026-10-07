"use strict";
/* ============================================================================
 * ui — DOM builders shared by the Editor and Setup tabs.
 *
 * Controls are bound to a model with UI.controls({ get, set, ctx, reg, repaint }):
 *   get(id) / set(id, value)   read and change a raw parameter value
 *   ctx(id)                    the id->value map the param lives in (for formats)
 *   reg(update)                each control registers an update() so a load or
 *                              an undo repaints everything in one pass
 *   repaint()                  ask for that pass
 * Display text comes from P2KD.format(); ranges and options from P2KD.PARAMS.
 * ==========================================================================*/
const UI = (() => {
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svg(tag, attrs, parent) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function card(parent, title, cls) {
    const c = el("section", "card" + (cls ? " " + cls : ""));
    const h = el("h3");
    h.appendChild(el("span", "", title));
    c.appendChild(h);
    parent.appendChild(c);
    return { card: c, head: h };
  }
  const cells = (parent) => { const c = el("div", "cells"); parent.appendChild(c); return c; };
  function sub(parent, title, cls) {
    parent.appendChild(el("h4", "", title));
    const c = cells(parent);
    if (cls) c.classList.add(cls);
    return c;
  }

  function cellBase(parent, label, cls) {
    const cell = el("div", "cell" + (cls ? " " + cls : ""));
    const lab = el("div", "lab");
    const name = el("span", "", label);
    const v = el("span", "v");
    lab.append(name, v);
    cell.appendChild(lab);
    parent.appendChild(cell);
    return { cell, name, v };
  }

  // options: [[value, label], ...] or [{ group, items: [[value, label], ...] }, ...].
  // A current value that isn't among them is kept, shown as "(value)".
  function fillSelect(s, options, current) {
    s.innerHTML = "";
    const vals = new Set();
    const add = (parent, [v, label]) => {
      const opt = el("option", "", label);
      opt.value = String(v);
      parent.appendChild(opt);
      vals.add(v);
    };
    for (const o of options) {
      if (Array.isArray(o)) add(s, o);
      else {
        const g = el("optgroup");
        g.label = o.group;
        o.items.forEach((it) => add(g, it));
        s.appendChild(g);
      }
    }
    s._vals = vals;
    if (!vals.has(current)) {
      const opt = el("option", "", "(" + current + ")");
      opt.value = String(current);
      s.insertBefore(opt, s.firstChild);
      vals.add(current);
    }
  }

  function controls(b) {
    const P = P2KD.PARAMS;

    // Click a value to type a raw number.
    function editable(vEl, id) {
      vEl.title = "Click to type a value";
      vEl.addEventListener("click", () => {
        const d = P[id];
        const inp = el("input", "vedit");
        inp.value = String(b.get(id));
        inp.title = d ? d.min + " … " + d.max : "";
        let finished = false;
        const done = (commit) => {
          if (finished) return;    // removing the input blurs it: don't commit twice (or after Escape)
          finished = true;
          if (commit) {
            const n = parseInt(inp.value, 10);
            if (!Number.isNaN(n)) b.set(id, n);
          }
          inp.replaceWith(vEl);
          b.repaint();
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") done(false);
          e.stopPropagation();
        });
        inp.addEventListener("blur", () => done(true));
        vEl.replaceWith(inp);
        inp.focus();
        inp.select();
      });
    }

    function slider(parent, id, o = {}) {
      const d = P[id];
      const { cell, name, v } = cellBase(parent, o.label !== undefined ? o.label : d.label, o.cls);
      const r = el("input");
      r.type = "range";
      r.min = String(o.min !== undefined ? o.min : d.min);
      r.max = String(o.max !== undefined ? o.max : d.max);
      r.step = "1";
      if (o.label === "") r.title = d.label;
      cell.appendChild(r);
      r.addEventListener("input", () => b.set(id, +r.value));
      editable(v, id);
      b.reg(() => {
        const x = b.get(id);
        cell.hidden = x === undefined;
        if (x === undefined) return;
        if (+r.value !== x) r.value = String(x);
        v.textContent = P2KD.format(id, x, b.ctx(id));
        if (o.dynLabel) name.textContent = o.dynLabel();
        cell.classList.toggle("dim", !!(o.dim && o.dim()));
      });
      return cell;
    }

    function choice(parent, id, o = {}) {
      const d = P[id];
      const { cell, v } = cellBase(parent, o.label !== undefined ? o.label : d.label, o.cls);
      v.remove();
      const s = el("select");
      if (o.label === "") s.title = d.label;
      cell.appendChild(s);
      s.addEventListener("change", () => b.set(id, +s.value));
      let sig;
      b.reg(() => {
        const x = b.get(id);
        cell.hidden = x === undefined;
        if (x === undefined) return;
        const nsig = o.sig ? o.sig() : "static";
        if (nsig !== sig || !s._vals.has(x)) {
          fillSelect(s, o.options ? o.options() : d.opts, x);
          sig = nsig;
        }
        if (s.value !== String(x)) s.value = String(x);
        cell.classList.toggle("dim", !!(o.dim && o.dim()));
      });
      return cell;
    }

    // On/off param as a button; `bare` puts just the button in `parent` (a card header).
    function toggle(parent, id, o = {}) {
      const d = P[id];
      const btn = el("button", "toggle");
      let wrap = btn;
      if (!o.bare) {
        const { cell, v } = cellBase(parent, o.label !== undefined ? o.label : d.label, o.cls);
        v.remove();
        cell.appendChild(btn);
        wrap = cell;
      } else parent.appendChild(btn);
      if (o.label === "") btn.title = d.label;
      btn.addEventListener("click", () => b.set(id, b.get(id) ? 0 : 1));
      b.reg(() => {
        const x = b.get(id);
        wrap.hidden = x === undefined;
        if (x === undefined) return;
        btn.classList.toggle("on", !!x);
        btn.textContent = (o.bare ? (o.label || d.label) + ": " : "") + P2KD.format(id, x);
        wrap.classList.toggle("dim", !!(o.dim && o.dim()));
      });
      return wrap;
    }

    return { editable, slider, choice, toggle };
  }

  /* ------------------------- ROM option lists ---------------------------- */
  const ROMS = typeof P2K_ROMS !== "undefined" ? P2K_ROMS : [];
  // ROMs that have `field` (instruments, riffs, ...), optionally with user memory first.
  const romOpts = (field, withUser) => {
    const list = ROMS.filter((r) => !field || (r[field] && r[field].length)).map((r) => [r.msb, P2KD.romLabel(r.msb)]);
    return withUser ? [[0, "User"], ...list] : list;
  };
  // Names like "pno:Stereo Grand" grouped by their category prefix.
  function grouped(names, first = 0) {
    const groups = [];
    let cur = null;
    names.forEach((nm, i) => {
      const k = nm.indexOf(":");
      const g = k > 0 ? nm.slice(0, k).trim() : "—";
      const label = (i + first) + "  " + (k >= 0 ? nm.slice(k + 1) : nm).trim();
      if (!cur || cur.group !== g) { cur = { group: g, items: [] }; groups.push(cur); }
      cur.items.push([i + first, label]);
    });
    return groups;
  }
  function instrumentOpts(romId) {
    const r = P2KD.romById(romId);
    if (!r || !r.instruments) return [[0, "None"]];
    return [[0, "None"], ...grouped(r.instruments.slice(1), 1)];
  }
  // Presets of a ROM (or the user banks, with the names read from the unit) by bank.
  function presetOpts(romId, { off = true } = {}) {
    const first = off ? [[-1, "Off"]] : [];
    if (romId === 0) {
      const groups = [];
      for (let b = 0; b < 4; b++) {
        const items = [];
        for (let pc = 0; pc < 128; pc++) {
          const n = b * 128 + pc;
          items.push([n, b + "·" + pc + "  " + (UserNames.get(n) || "")]);
        }
        groups.push({ group: "User bank " + b, items });
      }
      return [...first, ...groups];
    }
    const r = P2KD.romById(romId);
    if (!r) return first;
    return [...first, ...r.banks.map((bank, b) => ({
      group: "Bank " + b,
      items: bank.map((nm, pc) => [b * 128 + pc, b + "·" + pc + "  " + nm]),
    }))];
  }
  // Riffs of a ROM; `beatsFirst` lists the BTS (Beats) riffs in their own group first.
  function riffOpts(romId, { off = true, beatsFirst = false } = {}) {
    const r = P2KD.romById(romId);
    const first = off ? [[-1, "Off"]] : [];
    if (!r || !r.riffs) return first;
    const all = r.riffs.map((nm, i) => [i, i + "  " + nm]);
    if (!beatsFirst) return [...first, ...all];
    const isBeat = ([i]) => /^BTS/i.test(r.riffs[i]);
    const beats = all.filter(isBeat), other = all.filter((x) => !isBeat(x));
    return [...first, ...(beats.length ? [{ group: "Beats (BTS)", items: beats }] : []), { group: "Other riffs", items: other }];
  }
  function arpOpts(romId) {
    if (romId === 0) return Array.from({ length: 256 }, (_, i) => [i, "User pattern " + i]);
    const r = P2KD.romById(romId);
    if (!r || !r.arps || !r.arps.length) return [[0, "0"]];
    return r.arps.map((nm, i) => [i, i + "  " + nm]);
  }

  return {
    el, svg, card, cells, sub, fillSelect, controls,
    romOpts, instrumentOpts, presetOpts, riffOpts, arpOpts,
  };
})();
