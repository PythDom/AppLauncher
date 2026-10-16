(function () {
"use strict";

const A = window.Android;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state ----

let state = null;
let selectMode = false;
const selected = new Set();
let saveTimer = null;
let aiBusy = false;

const DEFAULT_AI = { provider: "anthropic", url: "", key: "", model: "claude-haiku-4-5-20251001", lang: "English" };

function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

function load() {
    try { const t = A.loadState(); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
}
function flush() {
    clearTimeout(saveTimer);
    try { A.saveState(JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function commit() { save(); render(); }

function newState() {
    return { v: 1, categories: [], items: [], unsortedCollapsed: false, ai: Object.assign({}, DEFAULT_AI) };
}

function catById(id) { return state.categories.find((c) => c.id === id); }
function itemById(id) { return state.items.find((i) => i.id === id); }
function catOf(i) { return i.catId ? catById(i.catId) : null; }

// ----------------------------------------------------------- app syncing ----

function installedApps() {
    try { return JSON.parse(A.listApps()); } catch (e) { return []; }
}

// Adds newly installed apps, drops uninstalled ones, refreshes labels.
function reconcile() {
    const apps = installedApps();
    if (!apps.length) return { added: 0, removed: 0 };
    const byPkg = new Map(apps.map((a) => [a.package, a]));
    let added = 0, removed = 0;
    state.items = state.items.filter((i) => {
        if (i.type !== "app" || byPkg.has(i.pkg)) return true;
        removed++;
        return false;
    });
    const have = new Set(state.items.filter((i) => i.type === "app").map((i) => i.pkg));
    for (const a of apps) {
        if (!have.has(a.package)) {
            state.items.push({ id: "a:" + a.package, type: "app", pkg: a.package, label: a.label, catId: null, page: 0 });
            added++;
        }
    }
    for (const i of state.items) {
        if (i.type === "app" && !i.customLabel) {
            const a = byPkg.get(i.pkg);
            if (a) i.label = a.label;
        }
    }
    return { added, removed };
}

// ------------------------------------------------------------- helpers ----

let toastTimer = null;
function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms || 2800);
}

function letterIcon(label) {
    const s = (label || "?").trim();
    const ch = (s.charAt(0) || "?").toUpperCase();
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 360;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="hsl('
        + h + ',45%,48%)"/><text x="48" y="64" font-size="50" font-family="sans-serif" fill="#fff" text-anchor="middle">'
        + ch.replace(/[<>&]/g, "") + "</text></svg>";
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function iconSrc(i) {
    if (i.icon) return i.icon;
    if (i.type === "app") return "/icon/" + encodeURIComponent(i.pkg) + ".png";
    try { return "https://www.google.com/s2/favicons?domain=" + new URL(i.url).hostname + "&sz=128"; }
    catch (e) { return letterIcon(i.label); }
}

function fileToIcon(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const img = new Image();
            img.onload = () => {
                const k = Math.min(1, 128 / Math.max(img.width, img.height));
                const c = document.createElement("canvas");
                c.width = Math.max(1, Math.round(img.width * k));
                c.height = Math.max(1, Math.round(img.height * k));
                c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL("image/png"));
            };
            img.onerror = reject;
            img.src = fr.result;
        };
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}

function normUrl(u) {
    u = (u || "").trim();
    if (!u) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
    return u;
}

function normName(n) {
    return String(n || "").replace(/\s+/g, " ").trim().slice(0, 32);
}

// --------------------------------------------------------- press handling ----

function attachPress(el, tap, long) {
    let timer = null, sx = 0, sy = 0, fired = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener("pointerdown", (e) => {
        fired = false; sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => {
            timer = null; fired = true;
            if (navigator.vibrate) navigator.vibrate(15);
            long();
        }, 450);
    });
    el.addEventListener("pointermove", (e) => {
        if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("click", (e) => {
        if (fired) { fired = false; e.preventDefault(); return; }
        tap();
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// -------------------------------------------------------------- rendering ----

function tile(item) {
    const t = document.createElement("div");
    t.className = "tile" + (selected.has(item.id) ? " sel" : "");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = iconSrc(item);
    img.onerror = () => { img.onerror = null; img.src = letterIcon(item.label); };
    const l = document.createElement("div");
    l.className = "lbl";
    l.textContent = item.label;
    t.append(img, l);
    attachPress(t, () => onTap(item), () => onLong(item));
    return t;
}

function groupBlock(title, items, opts) {
    const g = document.createElement("div");
    g.className = "group";
    const h = document.createElement("div");
    h.className = "ghead" + (opts.unsorted ? " unsorted" : "");
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = opts.collapsed ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = title;
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = items.length;
    h.append(chev, name, cnt);
    attachPress(h, opts.toggle, opts.long || (() => {}));
    g.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "grid" + (opts.collapsed ? " collapsed" : "");
    if (!items.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "Empty — move apps here from their long-press menu.";
        g.appendChild(e);
    } else {
        items.forEach((i) => grid.appendChild(tile(i)));
    }
    g.appendChild(grid);
    return g;
}

function renderPage(el, page) {
    el.innerHTML = "";
    const items = state.items.filter((i) => !i.hidden && i.page === page);
    let any = false;
    for (const c of state.categories) {
        const its = items.filter((i) => i.catId === c.id);
        if (!its.length && page !== 0) continue;
        any = true;
        el.appendChild(groupBlock(c.name, its, {
            collapsed: !!c.collapsed,
            toggle: () => { c.collapsed = !c.collapsed; commit(); },
            long: () => categorySheet(c)
        }));
    }
    const un = items.filter((i) => !catOf(i));
    if (un.length) {
        any = true;
        el.appendChild(groupBlock("Unsorted", un, {
            unsorted: true,
            collapsed: !!state.unsortedCollapsed,
            toggle: () => { state.unsortedCollapsed = !state.unsortedCollapsed; commit(); },
            long: () => unsortedSheet(un)
        }));
    }
    if (!any) {
        const e = document.createElement("div");
        e.className = "empty";
        e.style.padding = "40px 16px";
        e.style.textAlign = "center";
        e.textContent = page === 1
            ? "Second screen for rarely used apps.\nLong-press an app → “Move to second screen”."
            : "Nothing here yet. Tap ＋ to add a category or shortcut.";
        e.style.whiteSpace = "pre-line";
        el.appendChild(e);
    }
}

function render() {
    renderPage($("page0"), 0);
    renderPage($("page1"), 1);
    renderSelectBar();
    renderResults();
}

function renderSelectBar() {
    $("selbar").hidden = !selectMode;
    $("seln").textContent = selected.size + " selected";
}

function renderResults() {
    const q = $("q").value.trim().toLowerCase();
    const box = $("results");
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    const hits = state.items.filter((i) => !i.hidden && (i.label.toLowerCase().includes(q) || (i.pkg || "").toLowerCase().includes(q)));
    if (!hits.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "No match.";
        box.appendChild(e);
        return;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    hits.forEach((i) => grid.appendChild(tile(i)));
    box.appendChild(grid);
}

// -------------------------------------------------------- tap / long press ----

function launch(item) {
    if (item.type === "app") {
        let ok = false;
        try { ok = A.launch(item.pkg); } catch (e) { /* ignore */ }
        if (!ok) toast("Could not open " + item.label);
    } else {
        try { A.openUrl(item.url); } catch (e) { toast("Could not open link"); }
    }
}

function onTap(item) {
    if (selectMode) { toggleSelect(item.id); return; }
    launch(item);
}

function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    render();
}

function enterSelect(firstId) {
    selectMode = true;
    selected.clear();
    if (firstId) selected.add(firstId);
    render();
}

function exitSelect() {
    selectMode = false;
    selected.clear();
    render();
}

function onLong(item) {
    if (selectMode) { toggleSelect(item.id); return; }
    itemSheet(item);
}

// ----------------------------------------------------------------- overlay ----

function showCard(node) {
    const o = $("overlay");
    o.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.appendChild(node);
    o.appendChild(card);
    o.classList.add("open");
    o.onclick = (e) => { if (e.target === o) closeOverlay(); };
}

function closeOverlay() {
    const o = $("overlay");
    o.classList.remove("open");
    o.innerHTML = "";
}

function sheet(title, buttons) {
    const w = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    w.appendChild(h);
    buttons.forEach((b) => {
        const btn = document.createElement("button");
        btn.className = "sbtn" + (b.danger ? " danger" : "");
        btn.textContent = b.label;
        if (b.sub) { const s = document.createElement("small"); s.textContent = b.sub; btn.appendChild(s); }
        btn.onclick = () => { closeOverlay(); if (b.run) b.run(); };
        w.appendChild(btn);
    });
    const c = document.createElement("div");
    c.className = "row";
    const cb = document.createElement("button");
    cb.textContent = "Cancel";
    cb.onclick = closeOverlay;
    c.appendChild(cb);
    w.appendChild(c);
    showCard(w);
}

function form(title, fields, okLabel, onOk, extra) {
    const w = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    w.appendChild(h);
    const els = {};
    for (const f of fields) {
        const lab = document.createElement("label");
        let inp;
        if (f.type === "select") {
            inp = document.createElement("select");
            f.options.forEach((o) => {
                const op = document.createElement("option");
                op.value = o.value;
                op.textContent = o.label;
                inp.appendChild(op);
            });
            if (f.value !== undefined) inp.value = f.value;
        } else if (f.type === "textarea") {
            inp = document.createElement("textarea");
            inp.rows = f.rows || 6;
            inp.value = f.value || "";
        } else if (f.type === "checkbox") {
            inp = document.createElement("input");
            inp.type = "checkbox";
            inp.checked = !!f.value;
            lab.className = "chk";
        } else if (f.type === "file") {
            inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*";
            inp.onchange = async () => {
                if (!inp.files[0]) return;
                try { f._data = await fileToIcon(inp.files[0]); toast("Icon selected"); } catch (e) { toast("Could not read that image"); }
            };
        } else {
            inp = document.createElement("input");
            inp.type = f.type || "text";
            inp.value = f.value || "";
            if (f.placeholder) inp.placeholder = f.placeholder;
            inp.autocapitalize = "off";
            inp.autocomplete = "off";
        }
        els[f.id] = inp;
        if (f.type === "checkbox") { lab.appendChild(inp); lab.appendChild(document.createTextNode(f.label)); }
        else { lab.appendChild(document.createTextNode(f.label)); lab.appendChild(inp); }
        w.appendChild(lab);
    }
    const status = document.createElement("div");
    status.className = "note";
    w.appendChild(status);
    const gather = () => {
        const v = {};
        for (const f of fields) {
            const e = els[f.id];
            v[f.id] = f.type === "checkbox" ? e.checked : f.type === "file" ? f._data : e.value;
        }
        return v;
    };
    const row = document.createElement("div");
    row.className = "row";
    (extra || []).forEach((x) => {
        const b = document.createElement("button");
        b.textContent = x.label;
        b.onclick = () => x.run(gather(), (t) => { status.textContent = t; });
        row.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = closeOverlay;
    const ok = document.createElement("button");
    ok.className = "p";
    ok.textContent = okLabel || "Save";
    ok.onclick = () => {
        if (onOk(gather()) === false) return;
        closeOverlay();
    };
    row.append(cancel, ok);
    w.appendChild(row);
    showCard(w);
    const first = fields.length && els[fields[0].id];
    if (first && first.focus && fields[0].type !== "select" && fields[0].type !== "file") setTimeout(() => first.focus(), 60);
}

function confirmSheet(message, label, run) {
    sheet(message, [{ label, danger: true, run }]);
}

// --------------------------------------------------------------- categories ----

function ensureCat(name, created) {
    name = normName(name);
    if (!name) return null;
    const hit = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const c = { id: "c" + uid(), name, collapsed: false };
    state.categories.push(c);
    if (created) created.add(name);
    return c;
}

function addCategoryDialog(then) {
    form("New category", [{ id: "name", label: "Name", placeholder: "e.g. Music" }], "Create", (v) => {
        const n = normName(v.name);
        if (!n) { toast("Enter a name"); return false; }
        const c = ensureCat(n);
        commit();
        if (then) then(c);
    });
}

function chooseCategory(title, opts, cb) {
    const buttons = [];
    state.categories.forEach((c) => {
        if (opts.exclude && opts.exclude === c.id) return;
        const n = state.items.filter((i) => i.catId === c.id && !i.hidden).length;
        buttons.push({ label: c.name, sub: String(n), run: () => cb(c.id) });
    });
    if (opts.unsorted) buttons.push({ label: "Unsorted", run: () => cb(null) });
    if (opts.create !== false) buttons.push({ label: "＋ New category…", run: () => addCategoryDialog((c) => cb(c.id)) });
    sheet(title, buttons);
}

function categorySheet(c) {
    const idx = state.categories.indexOf(c);
    const n = state.items.filter((i) => i.catId === c.id).length;
    sheet(c.name, [
        { label: "Rename", run: () => form("Rename category", [{ id: "name", label: "Name", value: c.name }], "Rename", (v) => {
            const nn = normName(v.name);
            if (!nn) return false;
            const dup = state.categories.find((x) => x !== c && x.name.toLowerCase() === nn.toLowerCase());
            if (dup) { toast("A category with that name exists — use Merge"); return false; }
            c.name = nn; commit();
        }) },
        { label: "Move up", run: () => { if (idx > 0) { state.categories.splice(idx, 1); state.categories.splice(idx - 1, 0, c); commit(); } } },
        { label: "Move down", run: () => { if (idx < state.categories.length - 1) { state.categories.splice(idx, 1); state.categories.splice(idx + 1, 0, c); commit(); } } },
        { label: "Merge into…", run: () => {
            if (state.categories.length < 2) { toast("Need another category to merge with"); return; }
            chooseCategory("Merge “" + c.name + "” into", { exclude: c.id, create: false }, (to) => mergeCategory(c.id, to));
        } },
        { label: "Delete", danger: true, run: () => confirmSheet("Delete “" + c.name + "”? Its " + n + " items become Unsorted.", "Delete category", () => {
            state.items.forEach((i) => { if (i.catId === c.id) i.catId = null; });
            state.categories = state.categories.filter((x) => x !== c);
            commit();
        }) }
    ]);
}

function mergeCategory(fromId, toId) {
    const from = catById(fromId), to = catById(toId);
    if (!from || !to || from === to) return;
    state.items.forEach((i) => { if (i.catId === fromId) i.catId = toId; });
    state.categories = state.categories.filter((c) => c !== from);
    commit();
    toast("Merged “" + from.name + "” into “" + to.name + "”");
}

function unsortedSheet(items) {
    sheet("Unsorted (" + items.length + ")", [
        { label: "Sort with AI…", run: aiDialog },
        { label: "Select these", run: () => { selectMode = true; selected.clear(); items.forEach((i) => selected.add(i.id)); render(); } }
    ]);
}

// -------------------------------------------------------------------- items ----

function moveItems(ids, catId) {
    state.items.forEach((i) => { if (ids.has(i.id)) i.catId = catId; });
    commit();
}

function setPage(ids, page) {
    state.items.forEach((i) => { if (ids.has(i.id)) i.page = page; });
    commit();
}

function setHidden(ids, hidden) {
    state.items.forEach((i) => { if (ids.has(i.id)) i.hidden = hidden; });
    commit();
}

function itemSheet(item) {
    const ids = new Set([item.id]);
    const other = item.page === 0 ? "Move to second screen" : "Move to main screen";
    const buttons = [
        { label: "Move to category…", run: () => chooseCategory("Move “" + item.label + "” to", { unsorted: true }, (c) => moveItems(ids, c)) },
        { label: other, run: () => setPage(ids, item.page === 0 ? 1 : 0) },
        { label: "Select several…", run: () => enterSelect(item.id) }
    ];
    if (item.type === "app") {
        buttons.push({ label: "Rename", run: () => form("Rename", [{ id: "label", label: "Name", value: item.label }], "Rename", (v) => {
            const l = v.label.trim();
            if (!l) return false;
            item.label = l; item.customLabel = true; commit();
        }) });
        buttons.push({ label: "App info", run: () => { try { A.appInfo(item.pkg); } catch (e) { /* ignore */ } } });
        buttons.push({ label: "Hide from launcher", run: () => { setHidden(ids, true); toast("Hidden — bring it back via ＋ → Hidden app"); } });
        buttons.push({ label: "Uninstall…", danger: true, run: () => { try { A.uninstall(item.pkg); } catch (e) { /* ignore */ } } });
    } else {
        buttons.push({ label: "Edit shortcut", run: () => shortcutForm(item) });
        buttons.push({ label: "Remove shortcut", danger: true, run: () => confirmSheet("Remove “" + item.label + "”?", "Remove", () => {
            state.items = state.items.filter((i) => i.id !== item.id);
            commit();
        }) });
    }
    sheet(item.label, buttons);
}

function shortcutForm(item) {
    const opts = [{ value: "", label: "Unsorted" }].concat(state.categories.map((c) => ({ value: c.id, label: c.name })));
    form(item ? "Edit shortcut" : "New shortcut", [
        { id: "label", label: "Name", value: item ? item.label : "" },
        { id: "url", label: "Address (URL)", type: "url", value: item ? item.url : "", placeholder: "https://example.com" },
        { id: "cat", label: "Category", type: "select", options: opts, value: item ? (item.catId || "") : "" },
        { id: "icon", label: "Icon (optional — otherwise the site's icon)", type: "file" }
    ], "Save", (v) => {
        const label = v.label.trim(), url = normUrl(v.url);
        if (!label || !url) { toast("Name and address are required"); return false; }
        if (item) {
            item.label = label; item.url = url; item.catId = v.cat || null;
            if (v.icon) item.icon = v.icon;
        } else {
            const n = { id: "s:" + uid(), type: "link", label, url, catId: v.cat || null, page: 0 };
            if (v.icon) n.icon = v.icon;
            state.items.push(n);
        }
        commit();
    });
}

function hiddenAppsSheet() {
    const hidden = state.items.filter((i) => i.hidden);
    if (!hidden.length) { toast("No hidden apps"); return; }
    sheet("Hidden apps — tap to bring back", hidden.map((i) => ({ label: i.label, run: () => { setHidden(new Set([i.id]), false); } })));
}

// -------------------------------------------------------------------- menus ----

function addMenu() {
    sheet("Add", [
        { label: "Category", run: () => addCategoryDialog() },
        { label: "Shortcut (web link)", run: () => shortcutForm(null) },
        { label: "App (from hidden)", run: hiddenAppsSheet }
    ]);
}

function mainMenu() {
    sheet("Menu", [
        { label: "Sort with AI…", run: aiDialog },
        { label: "Select several…", run: () => enterSelect(null) },
        { label: "Rescan installed apps", run: () => { const r = reconcile(); commit(); toast(r.added + " new, " + r.removed + " removed"); } },
        { label: "Settings & backup…", run: settingsMenu }
    ]);
}

function settingsMenu() {
    sheet("Settings", [
        { label: "AI server…", run: aiSettings },
        { label: "Copy backup to clipboard", run: () => {
            const copy = JSON.parse(JSON.stringify(state));
            copy.ai.key = "";
            try { A.copyText(JSON.stringify(copy)); toast("Backup copied (without the AI key)"); } catch (e) { toast("Copy failed"); }
        } },
        { label: "Restore from pasted backup…", run: restoreForm },
        { label: "Reset all organisation", danger: true, run: () => confirmSheet("Delete all categories, shortcuts and settings and start over?", "Reset", () => {
            const ai = state.ai;
            state = newState();
            state.ai = ai;
            reconcile();
            commit();
            toast("Reset — all apps are unsorted again");
        }) }
    ]);
}

function restoreForm() {
    form("Restore backup", [{ id: "text", label: "Paste the backup text here", type: "textarea", rows: 8 }], "Restore", (v) => {
        try {
            const s = JSON.parse(v.text);
            if (!s || !Array.isArray(s.categories) || !Array.isArray(s.items)) throw new Error("not a backup");
            s.ai = Object.assign({}, DEFAULT_AI, state.ai, { key: state.ai.key });
            state = s;
            reconcile();
            commit();
            toast("Backup restored");
        } catch (e) {
            toast("That doesn't look like a valid backup");
            return false;
        }
    });
}

// ----------------------------------------------------------- selection bar ----

function selectedIds() { return new Set(selected); }

function selectionMove() {
    if (!selected.size) { toast("Select something first"); return; }
    chooseCategory("Move " + selected.size + " items to", { unsorted: true }, (c) => { moveItems(selectedIds(), c); exitSelect(); });
}

function selectionMore() {
    if (!selected.size) { toast("Select something first"); return; }
    const ids = selectedIds();
    sheet(selected.size + " selected", [
        { label: "Move to second screen", run: () => { setPage(ids, 1); exitSelect(); } },
        { label: "Move to main screen", run: () => { setPage(ids, 0); exitSelect(); } },
        { label: "Hide from launcher", run: () => { setHidden(ids, true); exitSelect(); } }
    ]);
}

// ---------------------------------------------------------------------- AI ----

function aiConfigured() {
    const a = state.ai;
    return a.provider === "anthropic" ? !!a.key : !!a.url;
}

const pending = {};
let httpSeq = 0;
window.__httpResult = function (id, status, text) {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    p.resolve({ status, text });
};

function httpPost(url, headers, body) {
    return new Promise((resolve) => {
        const id = ++httpSeq;
        pending[id] = { resolve };
        try { A.httpPost(id, url, JSON.stringify(headers), body); }
        catch (e) { delete pending[id]; resolve({ status: 0, text: String(e) }); }
    });
}

function endpoint(ai) {
    if (ai.provider === "anthropic") {
        return (ai.url || "https://api.anthropic.com").replace(/\/+$/, "") + "/v1/messages";
    }
    return ai.url.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/chat/completions";
}

async function aiAsk(system, user, maxTokens) {
    const ai = state.ai;
    let headers, body;
    if (ai.provider === "anthropic") {
        headers = { "content-type": "application/json", "x-api-key": ai.key, "anthropic-version": "2023-06-01" };
        body = { model: ai.model, max_tokens: maxTokens || 4096, system, messages: [{ role: "user", content: user }] };
    } else {
        headers = { "content-type": "application/json" };
        if (ai.key) headers.authorization = "Bearer " + ai.key;
        body = { model: ai.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    }
    const r = await httpPost(endpoint(ai), headers, JSON.stringify(body));
    if (r.status < 200 || r.status >= 300) {
        throw new Error((r.status || "network") + " " + String(r.text).slice(0, 160));
    }
    let data;
    try { data = JSON.parse(r.text); } catch (e) { throw new Error("Server did not return JSON"); }
    if (ai.provider === "anthropic") {
        return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    }
    return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
}

function parseJson(t) {
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s < 0 || e < s) throw new Error("No JSON in the reply");
    return JSON.parse(t.slice(s, e + 1));
}

const SYSTEM_PROMPT =
    "You organise the home screen of an Android phone. You receive installed apps and shortcuts as lines 'key | label'. " +
    "Put every line in exactly one category. Prefer the existing categories when they fit; otherwise create a new short category " +
    "(1-2 words, Title Case). Keep the total number of categories small (about 6 to 12). " +
    "Also set \"rare\": true for items a typical person rarely opens (system utilities, carrier or manufacturer bloatware, setup helpers). " +
    "Reply with ONLY a JSON object and no other text, exactly in this shape: " +
    "{\"categories\":[\"Name\"],\"apps\":{\"key\":{\"c\":\"Name\",\"rare\":false}}}";

function keyOf(i) { return i.type === "app" ? i.pkg : i.id; }

async function aiChunk(chunk) {
    const existing = state.categories.map((c) => c.name);
    const lines = chunk.map((i) => keyOf(i) + " | " + i.label + (i.type === "link" ? " (web shortcut: " + safeHost(i.url) + ")" : ""));
    const user = "Existing categories: " + (existing.length ? existing.join(", ") : "none") +
        "\nLanguage for new category names: " + (state.ai.lang || "English") + "\nAPPS:\n" + lines.join("\n");
    let text = await aiAsk(SYSTEM_PROMPT, user, 4096);
    try { return parseJson(text); }
    catch (e) {
        text = await aiAsk(SYSTEM_PROMPT, user + "\n\nYour previous reply was not valid JSON. Reply with the JSON object only.", 4096);
        return parseJson(text);
    }
}

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

function applyAi(res, chunk, opts, created) {
    const byKey = new Map(chunk.map((i) => [keyOf(i), i]));
    let n = 0;
    for (const [k, v] of Object.entries(res.apps || {})) {
        const it = byKey.get(k);
        if (!it) continue;
        const name = typeof v === "string" ? v : v && v.c;
        const cat = ensureCat(name, created);
        if (!cat) continue;
        it.catId = cat.id;
        if (opts.moveRare && v && v.rare) it.page = 1;
        n++;
    }
    return n;
}

async function aiSort(opts) {
    if (aiBusy) return;
    aiBusy = true;
    try {
        const targets = state.items.filter((i) => !i.hidden && (opts.scope === "all" || !catOf(i)));
        if (!targets.length) { toast("Nothing to sort"); return; }
        const chunks = [];
        for (let k = 0; k < targets.length; k += 70) chunks.push(targets.slice(k, k + 70));
        const created = new Set();
        let done = 0;
        for (let n = 0; n < chunks.length; n++) {
            toast("AI is sorting… " + (n + 1) + "/" + chunks.length, 90000);
            const res = await aiChunk(chunks[n]);
            done += applyAi(res, chunks[n], opts, created);
            save();
            render();
        }
        toast("AI sorted " + done + " of " + targets.length + " items (" + created.size + " new categories)", 5000);
    } catch (e) {
        toast("AI error: " + e.message, 7000);
    } finally {
        aiBusy = false;
    }
}

function aiDialog() {
    if (!aiConfigured()) { toast("Set up the AI server first"); aiSettings(); return; }
    const unsorted = state.items.filter((i) => !i.hidden && !catOf(i)).length;
    form("Sort with AI", [
        { id: "scope", label: "What to sort", type: "select", value: unsorted ? "unsorted" : "all", options: [
            { value: "unsorted", label: "Only unsorted items (" + unsorted + ")" },
            { value: "all", label: "Everything (re-sort)" }
        ] },
        { id: "moveRare", label: "Also move rarely needed apps to the second screen", type: "checkbox", value: false }
    ], "Start", (v) => { aiSort({ scope: v.scope, moveRare: v.moveRare }); });
}

function aiSettings() {
    const a = state.ai;
    form("AI server", [
        { id: "provider", label: "Type", type: "select", value: a.provider, options: [
            { value: "anthropic", label: "Claude API (Anthropic)" },
            { value: "openai", label: "OpenAI-compatible server (Ollama, LM Studio…)" }
        ] },
        { id: "url", label: "Server URL (blank = official Claude API)", type: "url", value: a.url, placeholder: "http://192.168.x.x:11434" },
        { id: "key", label: "API key (optional for local servers)", type: "password", value: a.key },
        { id: "model", label: "Model", value: a.model, placeholder: "claude-haiku-4-5-20251001 or llama3.1" },
        { id: "lang", label: "Language for category names", value: a.lang || "English" }
    ], "Save", (v) => {
        Object.assign(state.ai, { provider: v.provider, url: v.url.trim(), key: v.key.trim(), model: v.model.trim(), lang: v.lang.trim() || "English" });
        save();
        toast("AI settings saved");
    }, [{
        label: "Test",
        run: async (v, say) => {
            const saved = Object.assign({}, state.ai);
            Object.assign(state.ai, { provider: v.provider, url: v.url.trim(), key: v.key.trim(), model: v.model.trim() });
            say("Testing…");
            try {
                const t = await aiAsk("Reply with the JSON object {\"ok\":true} and nothing else.", "ping", 50);
                say("Connected ✓  " + String(t).slice(0, 80));
            } catch (e) {
                say("Failed: " + e.message);
            } finally {
                state.ai = saved;
            }
        }
    }]);
}

// ------------------------------------------------------------- navigation ----

function pagerPage() {
    const p = $("pager");
    return Math.round(p.scrollLeft / Math.max(1, p.clientWidth));
}

function goPage(n, smooth) {
    const p = $("pager");
    p.scrollTo({ left: n * p.clientWidth, behavior: smooth ? "smooth" : "auto" });
}

function updateDots() {
    const cur = pagerPage();
    document.querySelectorAll("#dots button").forEach((b) => b.classList.toggle("on", Number(b.dataset.p) === cur));
}

window.__launcherBack = function () {
    if ($("overlay").classList.contains("open")) { closeOverlay(); return true; }
    if (selectMode) { exitSelect(); return true; }
    if ($("q").value) { $("q").value = ""; renderResults(); return true; }
    if (pagerPage() !== 0) { goPage(0, true); return true; }
    return false;
};

window.__onHome = function () {
    closeOverlay();
    if (selectMode) exitSelect();
    $("q").value = "";
    $("q").blur();
    renderResults();
    goPage(0, true);
};

window.__onResume = function () {
    if (!state) return;
    const r = reconcile();
    if (r.added || r.removed) {
        commit();
        toast(r.added + " new app" + (r.added === 1 ? "" : "s") + (r.removed ? ", " + r.removed + " removed" : ""));
    }
};

window.__onPause = flush;

// -------------------------------------------------------------------- init ----

function init() {
    state = load();
    let first = false;
    if (!state || !Array.isArray(state.items)) { state = newState(); first = true; }
    state.ai = Object.assign({}, DEFAULT_AI, state.ai || {});
    const r = reconcile();
    flush();
    render();
    if (first) toast("Found " + r.added + " apps. ⋮ → Sort with AI, or long-press to organise.", 6000);

    $("q").addEventListener("input", renderResults);
    $("q").addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const q = $("q").value.trim().toLowerCase();
        const hit = q && state.items.find((i) => !i.hidden && i.label.toLowerCase().includes(q));
        if (hit) { launch(hit); $("q").value = ""; $("q").blur(); renderResults(); }
    });
    $("btnAdd").onclick = addMenu;
    $("btnMenu").onclick = mainMenu;
    $("selMove").onclick = selectionMove;
    $("selMore").onclick = selectionMore;
    $("selDone").onclick = exitSelect;
    $("pager").addEventListener("scroll", updateDots, { passive: true });
    document.querySelectorAll("#dots button").forEach((b) => { b.onclick = () => goPage(Number(b.dataset.p), true); });
}

init();
})();
