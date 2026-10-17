// Minimal iCalendar (.ics) reader: events in a time window, with the recurrence rules and time-zone names
// that Outlook.com / Google / Apple feeds actually use. No dependencies; also loads in Node for tests.
(function (root) {
"use strict";

// Outlook/Exchange write Windows zone names instead of IANA ones.
const WIN = {
    "UTC": "UTC", "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
    "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
    "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw",
    "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest",
    "Turkey Standard Time": "Europe/Istanbul", "Russian Standard Time": "Europe/Moscow", "Israel Standard Time": "Asia/Jerusalem",
    "Arab Standard Time": "Asia/Riyadh", "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
    "China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore", "Tokyo Standard Time": "Asia/Tokyo",
    "Korea Standard Time": "Asia/Seoul", "AUS Eastern Standard Time": "Australia/Sydney", "New Zealand Standard Time": "Pacific/Auckland",
    "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo", "W. Central Africa Standard Time": "Africa/Lagos",
    "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles", "Alaskan Standard Time": "America/Anchorage", "Hawaiian Standard Time": "Pacific/Honolulu",
    "Atlantic Standard Time": "America/Halifax", "Canada Central Standard Time": "America/Regina", "E. South America Standard Time": "America/Sao_Paulo",
    "Argentina Standard Time": "America/Argentina/Buenos_Aires", "SA Pacific Standard Time": "America/Bogota", "Mexico Standard Time": "America/Mexico_City"
};

const fmts = {};
function fmt(tz) {
    return fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    }));
}

function tzName(tzid) {
    if (!tzid) return null;
    if (WIN[tzid]) return WIN[tzid];
    try { fmt(tzid); return tzid; } catch (e) { return null; }
}

function offsetMs(epoch, tz) {
    const t = epoch - (((epoch % 1000) + 1000) % 1000);
    const o = {};
    fmt(tz).formatToParts(new Date(t)).forEach((p) => { o[p.type] = +p.value; });
    return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - t;
}

// Wall-clock time in a zone (null = the device's own zone) to epoch milliseconds.
function wallToEpoch(y, mo, d, h, mi, s, tz) {
    if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let t = guess - offsetMs(guess, tz);
    const o2 = offsetMs(t, tz);
    t = guess - o2;
    return t;
}

function unfold(text) {
    return String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseLine(line) {
    let inQ = false, at = -1;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQ = !inQ;
        else if (c === ":" && !inQ) { at = i; break; }
    }
    if (at < 0) return null;
    const parts = line.slice(0, at).split(";");
    const params = {};
    parts.slice(1).forEach((p) => {
        const e = p.indexOf("=");
        if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/"/g, "");
    });
    return { name: parts[0].toUpperCase(), params, value: line.slice(at + 1) };
}

const unescapeText = (s) => String(s || "").replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1");

// "20261018", "20261018T090000", "20261018T090000Z" -> wall-clock parts
function parseDt(prop) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
    if (!m) return null;
    const allDay = !m[4];
    return {
        y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
        allDay, utc: !!m[7], tz: m[7] ? "UTC" : (allDay ? null : tzName(prop.params.TZID))
    };
}

const dtEpoch = (p) => wallToEpoch(p.y, p.mo, p.d, p.h, p.mi, p.s, p.tz);

function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
    if (!m) return 0;
    const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] === "-" ? -ms : ms;
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(v) {
    const r = { freq: "", interval: 1, count: 0, until: null, byday: [], bymonthday: [], bymonth: [] };
    v.split(";").forEach((kv) => {
        const e = kv.indexOf("=");
        const k = kv.slice(0, e).toUpperCase(), val = kv.slice(e + 1);
        if (k === "FREQ") r.freq = val.toUpperCase();
        else if (k === "INTERVAL") r.interval = Math.max(1, +val || 1);
        else if (k === "COUNT") r.count = +val || 0;
        else if (k === "UNTIL") r.until = val;
        else if (k === "BYDAY") r.byday = val.split(",").map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim().toUpperCase()); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean);
        else if (k === "BYMONTHDAY") r.bymonthday = val.split(",").map(Number);
        else if (k === "BYMONTH") r.bymonth = val.split(",").map(Number);
    });
    return r;
}

const dim = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();                     // days in month (mo 1-12)
const wdayOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

// Dates (as [y, mo, d]) of one recurrence period, in order.
function periodDates(r, base, p) {
    const out = [];
    const day0 = Date.UTC(base.y, base.mo - 1, base.d);
    if (r.freq === "DAILY") {
        const t = new Date(day0 + p * r.interval * 86400000);
        out.push([t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]);
    } else if (r.freq === "WEEKLY") {
        const wd = wdayOf(base.y, base.mo, base.d);
        const monday = day0 - ((wd + 6) % 7) * 86400000 + p * r.interval * 7 * 86400000;
        const wds = r.byday.length ? r.byday.map((b) => b.wd) : [wd];
        wds.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).forEach((w) => {
            const t = new Date(monday + ((w + 6) % 7) * 86400000);
            out.push([t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]);
        });
    } else if (r.freq === "MONTHLY" || r.freq === "YEARLY") {
        let y = base.y, mo;
        if (r.freq === "MONTHLY") {
            const idx = base.y * 12 + (base.mo - 1) + p * r.interval;
            y = Math.floor(idx / 12);
            mo = (idx % 12) + 1;
        } else {
            y = base.y + p * r.interval;
            mo = r.bymonth.length ? r.bymonth[0] : base.mo;
        }
        if (r.freq === "MONTHLY" && r.bymonth.length && !r.bymonth.includes(mo)) return out;
        const n = dim(y, mo);
        const days = new Set();
        if (r.bymonthday.length) r.bymonthday.forEach((d) => { const dd = d < 0 ? n + d + 1 : d; if (dd >= 1 && dd <= n) days.add(dd); });
        else if (r.byday.length) {
            r.byday.forEach((b) => {
                const all = [];
                for (let d = 1; d <= n; d++) if (wdayOf(y, mo, d) === b.wd) all.push(d);
                if (!b.n) all.forEach((d) => days.add(d));
                else { const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (d) days.add(d); }
            });
        } else if (base.d <= n) days.add(base.d);
        [...days].sort((a, b) => a - b).forEach((d) => out.push([y, mo, d]));
    }
    return out;
}

function occurrences(ev, from, to) {
    const base = ev.start;
    const dur = ev.duration;
    const res = [];
    const hit = (begin) => {
        if (begin + Math.max(dur, 1) > from && begin < to && !ev.ex.has(begin)) res.push(begin);
    };
    if (!ev.rrule) { hit(dtEpoch(base)); return res; }
    const r = ev.rrule;
    if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq)) { hit(dtEpoch(base)); return res; }
    let until = null;
    if (r.until) { const u = parseDt({ value: r.until, params: {} }); if (u) until = u.allDay ? wallToEpoch(u.y, u.mo, u.d, 23, 59, 59, null) : dtEpoch(u); }
    const first = Date.UTC(base.y, base.mo - 1, base.d);
    let n = 0;
    for (let p = 0; p < 4000; p++) {
        const dates = periodDates(r, base, p);
        for (const [y, mo, d] of dates) {
            if (Date.UTC(y, mo - 1, d) < first) continue;
            if (r.freq === "DAILY" || r.freq === "WEEKLY") {
                if (r.bymonth.length && !r.bymonth.includes(mo)) continue;
                if (r.freq === "DAILY" && r.byday.length && !r.byday.some((b) => b.wd === wdayOf(y, mo, d))) continue;
            }
            const begin = wallToEpoch(y, mo, d, base.h, base.mi, base.s, base.tz);
            if (until !== null && begin > until) return res;
            n++;
            if (r.count && n > r.count) return res;
            if (begin >= to) return res;
            hit(begin);
        }
        if (!dates.length && p > 600) break;
    }
    return res;
}

// events overlapping [from, to) (epoch ms) -> [{title, begin, end, allDay, location}] sorted by begin.
// All-day events are returned as local midnight .. local midnight (end exclusive).
function parse(text, from, to, cap) {
    const lines = unfold(text);
    const events = [];
    let cur = null;
    for (const raw of lines) {
        const l = parseLine(raw);
        if (!l) continue;
        if (l.name === "BEGIN" && l.value.toUpperCase() === "VEVENT") { cur = { props: [] }; continue; }
        if (l.name === "END" && l.value.toUpperCase() === "VEVENT") { if (cur) events.push(cur); cur = null; continue; }
        if (cur) cur.props.push(l);
    }
    const masters = [], overrides = [];
    for (const e of events) {
        const get = (n) => e.props.find((p) => p.name === n);
        const all = (n) => e.props.filter((p) => p.name === n);
        const ds = get("DTSTART");
        if (!ds) continue;
        const st = get("STATUS");
        if (st && st.value.toUpperCase() === "CANCELLED") continue;
        const start = parseDt(ds);
        if (!start) continue;
        let duration;
        const de = get("DTEND"), du = get("DURATION");
        if (de) { const en = parseDt(de); duration = en ? dtEpoch(en) - dtEpoch(start) : 0; if (start.allDay && en) duration = Math.round((Date.UTC(en.y, en.mo - 1, en.d) - Date.UTC(start.y, start.mo - 1, start.d)) / 86400000) * 86400000; }
        else if (du) duration = parseDuration(du.value);
        else duration = start.allDay ? 86400000 : 0;
        const ex = new Set();
        all("EXDATE").forEach((p) => p.value.split(",").forEach((v) => {
            const d = parseDt({ value: v, params: p.params });
            if (d) ex.add(dtEpoch(d.allDay ? Object.assign({}, d, { h: start.h, mi: start.mi, s: start.s, tz: start.tz }) : d));
        }));
        const rr = get("RRULE");
        const rid = get("RECURRENCE-ID");
        const ev = {
            uid: (get("UID") || {}).value || "", start, duration, ex,
            rrule: rr ? parseRrule(rr.value) : null,
            title: unescapeText((get("SUMMARY") || {}).value) || "(no title)",
            location: unescapeText((get("LOCATION") || {}).value),
            rid: rid ? parseDt(rid) : null
        };
        (ev.rid ? overrides : masters).push(ev);
    }
    // an edited single occurrence replaces that occurrence of its series
    overrides.forEach((o) => {
        const m = masters.find((x) => x.uid === o.uid);
        if (m) m.ex.add(dtEpoch(Object.assign({}, o.rid, { tz: o.rid.allDay ? m.start.tz : (o.rid.tz || m.start.tz), h: o.rid.allDay ? m.start.h : o.rid.h, mi: o.rid.allDay ? m.start.mi : o.rid.mi, s: o.rid.allDay ? m.start.s : o.rid.s })));
    });
    const out = [];
    masters.concat(overrides).forEach((ev) => {
        const occ = ev.rid ? [dtEpoch(ev.start)].filter((b) => b + Math.max(ev.duration, 1) > from && b < to) : occurrences(ev, from, to);
        occ.forEach((begin) => {
            let end;
            if (ev.start.allDay) {
                const days = Math.max(1, Math.round(ev.duration / 86400000));
                const d0 = new Date(begin);
                end = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + days).getTime();
            } else end = begin + ev.duration;
            out.push({ title: ev.title, begin, end, allDay: ev.start.allDay, location: ev.location });
        });
    });
    out.sort((a, b) => a.begin - b.begin || a.title.localeCompare(b.title));
    return cap ? out.slice(0, cap) : out;
}

root.Ics = { parse, wallToEpoch, tzName };
if (typeof module !== "undefined" && module.exports) module.exports = root.Ics;
})(typeof window !== "undefined" ? window : globalThis);
