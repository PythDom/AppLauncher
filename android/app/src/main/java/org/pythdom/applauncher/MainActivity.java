package org.pythdom.applauncher;

import android.Manifest;
import android.app.Activity;
import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.CalendarContract;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Thin native shell. The whole UI is a local web page served from the APK's assets
 * under a private https://app.local origin (so it works offline and needs no network
 * to start). This class provides what a web page cannot do: list and launch apps,
 * app icons, persistent storage, AI HTTP calls (no CORS, plain-http LAN servers
 * allowed) and acting as the Android home screen.
 */
public class MainActivity extends Activity {

    private static final String HOST = "app.local";
    private static final String HOME_URL = "https://" + HOST + "/index.html";
    private static final int REQ_FILE = 1;
    private static final int REQ_CAL = 2;
    private static final int REQ_LOC = 3;
    private static final int ICON_PX = 144;

    private int pendingCalId = -1;
    private int pendingLocId = -1;

    private WebView web;
    private FrameLayout root;
    private ValueCallback<Uri[]> filePathCallback;
    private final Map<String, byte[]> icons = new HashMap<>();
    private Map<String, String> labelCache = new HashMap<>();     // "pkg@apkModified" -> label, kept on disk
    private boolean labelsLoaded = false;
    private String scanInfo = "";
    private String usageCache = "{}";
    private long usageAt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyColors();
        configureWebView();
        web.loadUrl(HOME_URL);
        Thread warm = new Thread(this::prewarmIcons);
        warm.setPriority(Thread.NORM_PRIORITY - 1);
        warm.start();
    }

    /** Renders any missing app icon into the on-disk cache so the first screen never waits for them. */
    private void prewarmIcons() {
        try {
            Intent main = new Intent(Intent.ACTION_MAIN, null);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            for (ResolveInfo ri : getPackageManager().queryIntentActivities(main, 0)) iconPng(ri.activityInfo.packageName);
        } catch (Exception e) {
            // best effort
        }
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private void applyColors() {
        boolean night = isNight();
        int bar = Color.parseColor(night ? "#1c1c1f" : "#d6d6da");
        int bg = Color.parseColor(night ? "#101012" : "#e9e9ec");
        getWindow().setStatusBarColor(bar);
        getWindow().setNavigationBarColor(bg);
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(night ? (flags & ~light) : (flags | light));
        root.setBackgroundColor(bg);
        web.setBackgroundColor(bg);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyColors();
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    if (path.startsWith("/icon/")) {
                        String pkg = Uri.decode(path.substring(6));
                        if (pkg.endsWith(".png")) pkg = pkg.substring(0, pkg.length() - 4);
                        byte[] png = iconPng(pkg);
                        if (png == null) return response("text/plain", 404, new byte[0]);
                        return response("image/png", 200, png);
                    }
                    InputStream in = getAssets().open(path.substring(1));
                    return response(mime(path), 200, readAll(in));
                } catch (IOException e) {
                    return response("text/plain", 404, new byte[0]);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("https".equals(u.getScheme()) && HOST.equals(u.getHost())) return false;
                openExternal(u.toString());
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    private WebResourceResponse response(String mime, int code, byte[] data) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        String text = code == 200 ? "OK" : "Not Found";
        return new WebResourceResponse(mime, "utf-8", code, text, headers, new ByteArrayInputStream(data));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private byte[] iconPng(String pkg) {
        synchronized (icons) {
            byte[] cached = icons.get(pkg);
            if (cached != null) return cached;
        }
        try {
            long stamp = 0;
            try {
                stamp = getPackageManager().getPackageInfo(pkg, 0).lastUpdateTime;   // new file name after an app update
            } catch (Exception e) {
                // fall through: getApplicationIcon below decides whether the app exists
            }
            File dir = new File(getFilesDir(), "icons");
            dir.mkdirs();
            File file = new File(dir, pkg + "@" + stamp + ".png");
            byte[] png = null;
            if (file.exists()) {
                try {
                    png = readAll(new FileInputStream(file));
                } catch (IOException e) {
                    png = null;
                }
            }
            if (png == null) {
                Drawable d = getPackageManager().getApplicationIcon(pkg);
                Bitmap bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bmp);
                d.setBounds(0, 0, ICON_PX, ICON_PX);
                d.draw(canvas);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
                png = bos.toByteArray();
                try {
                    File tmp = new File(dir, pkg + ".tmp");
                    OutputStream out = new FileOutputStream(tmp);
                    try {
                        out.write(png);
                    } finally {
                        out.close();
                    }
                    if (tmp.renameTo(file)) {
                        File[] old = dir.listFiles();
                        if (old != null) {
                            for (File o : old) {
                                if (o.getName().startsWith(pkg + "@") && !o.getName().equals(file.getName())) o.delete();
                            }
                        }
                    }
                } catch (IOException e) {
                    // the in-memory copy still serves this run
                }
            }
            synchronized (icons) {
                icons.put(pkg, png);
            }
            return png;
        } catch (Exception e) {
            return null;
        }
    }

    private void openCalendarDay(long time) {
        try {
            Uri.Builder b = CalendarContract.CONTENT_URI.buildUpon().appendPath("time");
            ContentUris.appendId(b, time);
            startActivity(new Intent(Intent.ACTION_VIEW).setData(b.build()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Toast.makeText(this, "No calendar app found to open this", Toast.LENGTH_SHORT).show();
        }
    }

    /** Answer to a request the page made through window.Android (see __nativeResult in app.js). */
    void nativeResult(int id, String json) {
        final String js = "window.__nativeResult(" + id + "," + JSONObject.quote(json) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        boolean ok = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_CAL && pendingCalId >= 0) {
            int id = pendingCalId;
            pendingCalId = -1;
            nativeResult(id, "{\"granted\":" + ok + "}");
        } else if (code == REQ_LOC && pendingLocId >= 0) {
            int id = pendingLocId;
            pendingLocId = -1;
            if (ok) locate(id); else nativeResult(id, "{\"granted\":false}");
        } else {
            super.onRequestPermissionsResult(code, perms, res);
        }
    }

    /** Approximate position: a recent last-known fix, else one network fix (20 s limit). */
    private void locate(final int id) {
        final LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        Location best = null;
        try {
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
        } catch (SecurityException e) {
            nativeResult(id, "{\"granted\":false}");
            return;
        }
        final Location last = best;
        if (last != null && System.currentTimeMillis() - last.getTime() < 3L * 3600 * 1000) {
            deliverLocation(id, last);
            return;
        }
        if (!lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            if (last != null) deliverLocation(id, last);
            else nativeResult(id, "{\"granted\":true,\"error\":\"Location is switched off in Android settings\"}");
            return;
        }
        final Handler h = new Handler(Looper.getMainLooper());
        final boolean[] done = {false};
        final LocationListener ll = new LocationListener() {
            @Override public void onLocationChanged(Location l) {
                if (done[0]) return;
                done[0] = true;
                lm.removeUpdates(this);
                deliverLocation(id, l);
            }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onProviderDisabled(String provider) { }
        };
        try {
            lm.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, ll, Looper.getMainLooper());
        } catch (SecurityException e) {
            nativeResult(id, "{\"granted\":false}");
            return;
        }
        h.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            lm.removeUpdates(ll);
            if (last != null) deliverLocation(id, last);
            else nativeResult(id, "{\"granted\":true,\"error\":\"No location fix yet. Try again in a moment.\"}");
        }, 20000);
    }

    private void deliverLocation(final int id, final Location l) {
        new Thread(() -> {
            String place = "";
            try {
                if (Geocoder.isPresent()) {
                    List<Address> a = new Geocoder(MainActivity.this, Locale.getDefault()).getFromLocation(l.getLatitude(), l.getLongitude(), 1);
                    if (a != null && !a.isEmpty()) {
                        Address ad = a.get(0);
                        place = ad.getLocality() != null ? ad.getLocality() : (ad.getSubAdminArea() != null ? ad.getSubAdminArea() : "");
                    }
                }
            } catch (Exception e) {
                // no geocoder service: the page names the place from the time zone instead
            }
            JSONObject o = new JSONObject();
            try {
                o.put("granted", true);
                o.put("lat", l.getLatitude());
                o.put("lon", l.getLongitude());
                o.put("place", place);
            } catch (Exception e) {
                // ignore
            }
            nativeResult(id, o.toString());
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && filePathCallback != null) {
            filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void openExternal(String url) {
        try {
            Intent intent;
            if (url.startsWith("intent:")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean isDefaultHome() {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        ResolveInfo ri = getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        return ri != null && ri.activityInfo != null && getPackageName().equals(ri.activityInfo.packageName);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__launcherBack&&window.__launcherBack()", value -> {
            if ("true".equals(value)) return;
            if (!isDefaultHome()) finish();
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (Intent.ACTION_MAIN.equals(intent.getAction())) {
            web.evaluateJavascript("window.__onHome&&window.__onHome()", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.evaluateJavascript("window.__onResume&&window.__onResume()", null);
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.__onPause&&window.__onPause()", null);
        web.onPause();
        super.onPause();
    }

    private synchronized void loadLabelCache() {
        if (labelsLoaded) return;
        labelsLoaded = true;
        try {
            File f = new File(getFilesDir(), "labels.json");
            if (!f.exists()) return;
            JSONObject o = new JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
            Iterator<String> keys = o.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                labelCache.put(k, o.getString(k));
            }
        } catch (Exception e) {
            labelCache = new HashMap<>();
        }
    }

    private synchronized void saveLabelCache(Map<String, String> next) {
        if (next.equals(labelCache)) return;
        labelCache = next;
        try {
            File tmp = new File(getFilesDir(), "labels.json.tmp");
            OutputStream out = new FileOutputStream(tmp);
            try {
                out.write(new JSONObject(next).toString().getBytes(StandardCharsets.UTF_8));
            } finally {
                out.close();
            }
            File dst = new File(getFilesDir(), "labels.json");
            if (!tmp.renameTo(dst)) {
                dst.delete();
                tmp.renameTo(dst);
            }
        } catch (Exception e) {
            // the next scan simply recomputes the labels
        }
    }

    /** Launchable apps as [{label, package}]. Loading a label is slow (it reads the app's resources), so labels
     *  are cached on disk by package + apk modification time and only new or updated apps are read. */
    private String scanApps() {
        try {
            long t0 = System.currentTimeMillis();
            loadLabelCache();
            PackageManager pm = getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN, null);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> found = pm.queryIntentActivities(main, 0);
            long t1 = System.currentTimeMillis();
            Map<String, String> next = new HashMap<>();
            List<String[]> rows = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            int cached = 0;
            for (ResolveInfo ri : found) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(getPackageName()) || !seen.add(pkg)) continue;
                long stamp = 0;
                try {
                    stamp = new File(ri.activityInfo.applicationInfo.sourceDir).lastModified();
                } catch (Exception e) {
                    // no stamp: the label is simply reloaded
                }
                String key = pkg + "@" + stamp;
                String label;
                synchronized (this) {
                    label = labelCache.get(key);
                }
                if (label == null) label = ri.loadLabel(pm).toString();
                else cached++;
                next.put(key, label);
                rows.add(new String[]{label, pkg});
            }
            Collections.sort(rows, (a, b) -> a[0].compareToIgnoreCase(b[0]));
            JSONArray arr = new JSONArray();
            for (String[] r : rows) {
                JSONObject o = new JSONObject();
                o.put("label", r[0]);
                o.put("package", r[1]);
                arr.put(o);
            }
            saveLabelCache(next);
            long t2 = System.currentTimeMillis();
            scanInfo = "query " + (t1 - t0) + " ms, labels " + (t2 - t1) + " ms (" + cached + " of " + rows.size() + " from cache)";
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /** window.Android.* — called from the page on a background thread. */
    public class Bridge {

        @JavascriptInterface
        public String listApps() {
            return scanApps();
        }

        /** Same list, computed off the page's thread; the answer arrives through window.__nativeResult. */
        @JavascriptInterface
        public void listAppsAsync(final int id) {
            new Thread(() -> nativeResult(id, scanApps())).start();
        }

        @JavascriptInterface
        public String scanInfo() {
            return scanInfo;
        }

        @JavascriptInterface
        public boolean launch(String pkg) {
            try {
                final Intent intent = getPackageManager().getLaunchIntentForPackage(pkg);
                if (intent == null) return false;
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                runOnUiThread(() -> startActivity(intent));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> openExternal(url));
        }

        /** Open a web address in one chosen browser; falls back to the default when it is gone or the link is not http(s). */
        @JavascriptInterface
        public void openUrlIn(final String url, final String pkg) {
            runOnUiThread(() -> {
                if (pkg != null && !pkg.isEmpty() && url.toLowerCase(Locale.ROOT).matches("^https?://.*")) {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                        return;
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "That browser is not available, using the default", Toast.LENGTH_SHORT).show();
                    }
                }
                openExternal(url);
            });
        }

        /** Installed browsers as [{label, package}]. */
        @JavascriptInterface
        public String browsers() {
            JSONArray arr = new JSONArray();
            try {
                PackageManager pm = getPackageManager();
                Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE);
                List<ResolveInfo> found = pm.queryIntentActivities(probe, PackageManager.MATCH_ALL);
                Set<String> seen = new HashSet<>();
                List<String[]> rows = new ArrayList<>();
                for (ResolveInfo ri : found) {
                    String pkg = ri.activityInfo.packageName;
                    if (pkg.equals(getPackageName()) || !seen.add(pkg)) continue;
                    rows.add(new String[]{ri.loadLabel(pm).toString(), pkg});
                }
                Collections.sort(rows, (a, b) -> a[0].compareToIgnoreCase(b[0]));
                for (String[] r : rows) {
                    JSONObject o = new JSONObject();
                    o.put("label", r[0]);
                    o.put("package", r[1]);
                    arr.put(o);
                }
            } catch (Exception e) {
                // empty list: the form then only offers the default browser
            }
            return arr.toString();
        }

        @JavascriptInterface
        public void appInfo(final String pkg) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", pkg, null));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot open app info", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void uninstall(final String pkg) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot uninstall this app", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** True once the user has allowed "Usage access" for this app in Android settings. */
        @JavascriptInterface
        public boolean usageAccess() {
            try {
                AppOpsManager ops = (AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
                int mode = ops.checkOpNoThrow("android:get_usage_stats", android.os.Process.myUid(), getPackageName());
                return mode == AppOpsManager.MODE_ALLOWED;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void openUsageSettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    try {
                        Intent i = new Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Exception e2) {
                        Toast.makeText(MainActivity.this, "Cannot open usage access settings", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        /** {"package": millisecondsInForeground} over the last 30 days; {} without permission. */
        @JavascriptInterface
        public String usageStats() {
            synchronized (MainActivity.this) {
                if (System.currentTimeMillis() - usageAt < 120000) return usageCache;
            }
            JSONObject o = new JSONObject();
            try {
                UsageStatsManager m = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
                long end = System.currentTimeMillis();
                long start = end - 30L * 24 * 60 * 60 * 1000;
                Map<String, UsageStats> map = m.queryAndAggregateUsageStats(start, end);
                for (Map.Entry<String, UsageStats> e : map.entrySet()) {
                    long t = e.getValue().getTotalTimeInForeground();
                    if (t > 0) o.put(e.getKey(), t);
                }
            } catch (Exception e) {
                // no permission or no data: the page falls back to launch counts
            }
            synchronized (MainActivity.this) {
                usageCache = o.toString();
                usageAt = System.currentTimeMillis();
                return usageCache;
            }
        }

        @JavascriptInterface
        public String loadState() {
            File f = new File(getFilesDir(), "state.json");
            if (!f.exists()) return "";
            try {
                return new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8);
            } catch (IOException e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveState(String json) {
            File tmp = new File(getFilesDir(), "state.json.tmp");
            File dst = new File(getFilesDir(), "state.json");
            try {
                OutputStream out = new FileOutputStream(tmp);
                try {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                } finally {
                    out.close();
                }
                if (!tmp.renameTo(dst)) {
                    dst.delete();
                    tmp.renameTo(dst);
                }
            } catch (IOException e) {
                // keep the previous state file
            }
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("launcher", text));
            });
        }

        /** Async POST for the AI server; the result comes back through window.__httpResult(id, status, text). */
        @JavascriptInterface
        public void httpPost(final int id, final String url, final String headersJson, final String body) {
            new Thread(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(300000);
                    c.setDoOutput(true);
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> keys = h.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        c.setRequestProperty(k, h.getString(k));
                    }
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(bytes.length);
                    OutputStream out = c.getOutputStream();
                    out.write(bytes);
                    out.close();
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    status = 0;
                    text = String.valueOf(e.getMessage() != null ? e.getMessage() : e);
                } finally {
                    if (c != null) c.disconnect();
                }
                final String js = "window.__httpResult(" + id + "," + status + "," + JSONObject.quote(text) + ")";
                runOnUiThread(() -> web.evaluateJavascript(js, null));
            }).start();
        }

        /** Async GET (weather, calendar feeds); follows redirects, even http<->https. Result via window.__httpResult. */
        @JavascriptInterface
        public void httpGet(final int id, final String startUrl) {
            new Thread(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    String url = startUrl;
                    for (int hop = 0; hop < 5; hop++) {
                        c = (HttpURLConnection) new URL(url).openConnection();
                        c.setRequestMethod("GET");
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(30000);
                        c.setInstanceFollowRedirects(false);
                        c.setRequestProperty("User-Agent", "AppLauncher/1.0");
                        c.setRequestProperty("Accept", "*/*");
                        status = c.getResponseCode();
                        if (status >= 300 && status < 400 && c.getHeaderField("Location") != null) {
                            url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                            c.disconnect();
                            continue;
                        }
                        break;
                    }
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    status = 0;
                    text = String.valueOf(e.getMessage() != null ? e.getMessage() : e);
                } finally {
                    if (c != null) c.disconnect();
                }
                final String js = "window.__httpResult(" + id + "," + status + "," + JSONObject.quote(text) + ")";
                runOnUiThread(() -> web.evaluateJavascript(js, null));
            }).start();
        }

        // ---- device calendar (any account on the phone: Google, Samsung, Outlook/Exchange...) ----

        @JavascriptInterface
        public boolean hasCalendarAccess() {
            return checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestCalendarAccess(final int id) {
            runOnUiThread(() -> {
                if (hasCalendarAccess()) {
                    nativeResult(id, "{\"granted\":true}");
                } else {
                    pendingCalId = id;
                    requestPermissions(new String[]{Manifest.permission.READ_CALENDAR}, REQ_CAL);
                }
            });
        }

        /** [{id, name, account, type, color, visible}] */
        @JavascriptInterface
        public String calendars() {
            JSONArray arr = new JSONArray();
            if (!hasCalendarAccess()) return arr.toString();
            String[] proj = {CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                    CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.ACCOUNT_TYPE,
                    CalendarContract.Calendars.CALENDAR_COLOR, CalendarContract.Calendars.VISIBLE};
            try (Cursor c = getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, proj, null, null,
                    CalendarContract.Calendars.ACCOUNT_NAME + ", " + CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)) {
                while (c != null && c.moveToNext()) {
                    JSONObject o = new JSONObject();
                    o.put("id", String.valueOf(c.getLong(0)));
                    o.put("name", c.getString(1));
                    o.put("account", c.getString(2));
                    o.put("type", c.getString(3));
                    o.put("color", String.format(Locale.US, "#%06X", 0xFFFFFF & c.getInt(4)));
                    o.put("visible", c.getInt(5) != 0);
                    arr.put(o);
                }
            } catch (Exception e) {
                // permission revoked meanwhile or provider missing: empty list
            }
            return arr.toString();
        }

        /** Event instances in [begin, end) as [{id, title, begin, end, allDay, location, cal}]. idsJson: JSON array of calendar ids, or "null" for all. */
        @JavascriptInterface
        public String events(double begin, double end, String idsJson) {
            JSONArray arr = new JSONArray();
            if (!hasCalendarAccess()) return arr.toString();
            Set<String> ids = null;
            try {
                if (idsJson != null && idsJson.startsWith("[")) {
                    JSONArray ja = new JSONArray(idsJson);
                    ids = new HashSet<>();
                    for (int i = 0; i < ja.length(); i++) ids.add(String.valueOf(ja.get(i)));
                }
            } catch (Exception e) {
                ids = null;
            }
            Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
            ContentUris.appendId(b, (long) begin);
            ContentUris.appendId(b, (long) end);
            String[] full = {"event_id", "title", "begin", "end", "allDay", "eventLocation", "calendar_id", "selfAttendeeStatus", "eventStatus"};
            String[] basic = {"event_id", "title", "begin", "end", "allDay", "eventLocation", "calendar_id"};
            Cursor c;
            boolean extra = true;
            try {
                c = getContentResolver().query(b.build(), full, null, null, "begin ASC");
            } catch (Exception e) {
                extra = false;
                try {
                    c = getContentResolver().query(b.build(), basic, null, null, "begin ASC");
                } catch (Exception e2) {
                    return arr.toString();
                }
            }
            try {
                while (c != null && c.moveToNext() && arr.length() < 400) {
                    String cal = String.valueOf(c.getLong(6));
                    if (ids != null && !ids.contains(cal)) continue;
                    if (extra && (c.getInt(7) == 2 /* declined */ || c.getInt(8) == 2 /* cancelled */)) continue;
                    JSONObject o = new JSONObject();
                    o.put("id", c.getLong(0));
                    o.put("title", c.getString(1));
                    o.put("begin", c.getLong(2));
                    o.put("end", c.getLong(3));
                    o.put("allDay", c.getInt(4) != 0);
                    o.put("location", c.getString(5));
                    o.put("cal", cal);
                    arr.put(o);
                }
            } catch (Exception e) {
                // return what we have
            } finally {
                if (c != null) c.close();
            }
            return arr.toString();
        }

        /** Opens one calendar event in the phone's calendar app; falls back to that day if the event view is refused. */
        @JavascriptInterface
        public void openEvent(final double eventId, final double begin, final double end) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW)
                            .setData(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, (long) eventId))
                            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, (long) begin)
                            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, (long) end)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    openCalendarDay((long) begin);
                }
            });
        }

        /** Opens the calendar app on the day of the given time (for events that only exist as a calendar link). */
        @JavascriptInterface
        public void openCalendarAt(final double time) {
            runOnUiThread(() -> openCalendarDay((long) time));
        }

        // ---- approximate location (for the weather) ----

        @JavascriptInterface
        public boolean hasLocationAccess() {
            return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }

        /** Answers through __nativeResult with {granted, lat, lon, place} or {granted, error}. */
        @JavascriptInterface
        public void requestLocation(final int id) {
            runOnUiThread(() -> {
                if (hasLocationAccess()) {
                    locate(id);
                } else {
                    pendingLocId = id;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
                }
            });
        }
    }
}
