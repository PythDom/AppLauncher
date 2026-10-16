// Development stand-in for the native bridge. Inside the APK window.Android already
// exists, so this file does nothing there. In a desktop browser it fakes the phone.
(function () {
    if (window.Android) return;
    window.__MOCK = true;

    const apps = [
        ["Gmail", "com.google.android.gm"], ["Chrome", "com.android.chrome"], ["Maps", "com.google.android.apps.maps"],
        ["WhatsApp", "com.whatsapp"], ["Messenger", "com.facebook.orca"], ["Telegram", "org.telegram.messenger"],
        ["Instagram", "com.instagram.android"], ["Facebook", "com.facebook.katana"], ["YouTube", "com.google.android.youtube"],
        ["Spotify", "com.spotify.music"], ["Deezer", "deezer.android.app"], ["Netflix", "com.netflix.mediaclient"],
        ["Camera", "com.sec.android.app.camera"], ["Gallery", "com.sec.android.gallery3d"], ["Photos", "com.google.android.apps.photos"],
        ["Calculator", "com.sec.android.app.popupcalculator"], ["Clock", "com.sec.android.app.clockpackage"],
        ["Calendar", "com.google.android.calendar"], ["Contacts", "com.samsung.android.contacts"], ["Phone", "com.samsung.android.dialer"],
        ["Messages", "com.samsung.android.messaging"], ["Settings", "com.android.settings"], ["Files", "com.sec.android.app.myfiles"],
        ["Easy Banking", "com.bnpp.easybanking"], ["PayPal", "com.paypal.android.p2pmobile"], ["Revolut", "com.revolut.revolut"],
        ["Ultimate Guitar", "com.ultimateguitar.tabs"], ["Tuner", "org.billthefarmer.tuner"], ["BandLab", "com.bandlab.bandlab"],
        ["Fender Tone", "com.fender.tone"], ["Voice Recorder", "com.sec.android.app.voicenote"], ["Play Store", "com.android.vending"],
        ["F-Droid", "org.fdroid.fdroid"], ["Claude", "com.anthropic.claude"], ["Samsung Members", "com.samsung.android.voc"],
        ["Bixby", "com.samsung.android.bixby.agent"], ["SmartThings", "com.samsung.android.oneconnect"],
        ["Galaxy Store", "com.sec.android.app.samsungapps"], ["Digital Wellbeing", "com.samsung.android.forest"],
        ["Strava", "com.strava"], ["SNCB", "be.sncb.mobile"], ["Zebra Quest", "org.example.zebraquest"]
    ].map((a) => ({ label: a[0], package: a[1] }));

    const rules = [
        ["Communication", /whatsapp|messenger|telegram|gmail|contacts|phone|messages|dialer/],
        ["Social", /instagram|facebook/],
        ["Media", /youtube|spotify|deezer|netflix|photos|gallery|camera/],
        ["Music Tools", /guitar|tuner|bandlab|fender|voicenote/],
        ["Finance", /bank|paypal|revolut/],
        ["Travel", /maps|sncb/],
        ["Utilities", /calculator|clock|calendar|files|settings|chrome|strava/],
        ["Stores", /vending|fdroid|samsungapps/],
        ["AI", /anthropic/]
    ];

    function fakeModel(user) {
        const lines = user.split(/(?:APPS|ITEMS):\n/)[1].split("\n");
        const out = { categories: [], apps: {} };
        for (const line of lines) {
            const m = line.match(/^(\S+) \| (.*)$/);
            if (!m) continue;
            const key = m[1], hay = (m[1] + " " + m[2]).toLowerCase();
            let cat = "Other";
            for (const [name, re] of rules) if (re.test(hay)) { cat = name; break; }
            if (!out.categories.includes(cat)) out.categories.push(cat);
            out.apps[key] = { c: cat, rare: /samsung|bixby|members|wellbeing|smartthings|galaxy/.test(hay) };
        }
        return "Here you go:\n```json\n" + JSON.stringify(out) + "\n```";
    }

    window.Android = {
        listApps: () => JSON.stringify(apps),
        launch: (p) => { console.log("launch", p); window.__lastLaunch = p; return true; },
        openUrl: (u) => { console.log("openUrl", u); window.__lastUrl = u; },
        appInfo: (p) => console.log("appInfo", p),
        uninstall: (p) => console.log("uninstall", p),
        loadState: () => localStorage.getItem("mock-state") || "",
        saveState: (s) => localStorage.setItem("mock-state", s),
        copyText: (t) => { window.__clip = t; },
        httpPost: (id, url, headers, body) => {
            setTimeout(() => {
                try {
                    const b = JSON.parse(body);
                    const anthropic = /anthropic|mock-claude/.test(url);
                    const user = anthropic ? b.messages[0].content : b.messages[1].content;
                    if (/mock-empty/.test(url)) { window.__httpResult(id, 200, JSON.stringify({ choices: [{ message: { content: "" } }] })); return; }
                    if (/mock-reason/.test(url)) { window.__httpResult(id, 200, JSON.stringify({ choices: [{ message: { content: "", reasoning: "Let me think..." } }] })); return; }
                    if (/mock-fail/.test(url)) { window.__httpResult(id, 500, '{"error":"model overloaded"}'); return; }
                    let text = user === "ping" ? '{"ok":true}' : fakeModel(user);
                    if (user !== "ping") {
                        const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
                        const lines = user.split(/(?:APPS|ITEMS):\n/)[1].split("\n").map((l) => l.match(/^(\S+) \| (.*)$/)).filter(Boolean);
                        if (/mock-garbage/.test(url)) text = "I'm sorry, I can't help with that.";
                        else if (/mock-think/.test(url)) text = "<think>maybe {\"x\":1} first</think>" + JSON.stringify(obj);
                        else if (/mock-lines/.test(url)) text = "Sure! Here is the sorting:\n```\n" + lines.map((m, n) => (n % 2 ? "- " : "") + m[1] + " | " + obj.apps[m[1]].c + " | " + (obj.apps[m[1]].rare ? "rare" : "common")).join("\n") + "\n```\nHope that helps!";
                        else if (/mock-array/.test(url)) text = JSON.stringify({ apps: lines.map((m) => ({ package: m[1], category: obj.apps[m[1]].c })) });
                        else if (/mock-bycat/.test(url)) {
                            const g = {};
                            lines.forEach((m) => { (g[obj.apps[m[1]].c] = g[obj.apps[m[1]].c] || []).push(m[2]); });
                            text = JSON.stringify(g);
                        } else if (/mock-nomatch/.test(url)) text = JSON.stringify({ apps: { "no.such.pkg": { c: "X" } } });
                    }
                    const payload = anthropic ? { content: [{ type: "text", text }] } : { choices: [{ message: { content: text } }] };
                    window.__httpResult(id, 200, JSON.stringify(payload));
                } catch (e) {
                    window.__httpResult(id, 500, String(e));
                }
            }, 250);
        }
    };
})();
