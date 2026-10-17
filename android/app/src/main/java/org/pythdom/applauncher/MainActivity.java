package org.pythdom.applauncher;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
    private static final int ICON_PX = 144;

    private WebView web;
    private FrameLayout root;
    private ValueCallback<Uri[]> filePathCallback;
    private final Map<String, byte[]> icons = new HashMap<>();

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
            Drawable d = getPackageManager().getApplicationIcon(pkg);
            Bitmap bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            d.setBounds(0, 0, ICON_PX, ICON_PX);
            d.draw(canvas);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
            byte[] png = bos.toByteArray();
            synchronized (icons) {
                icons.put(pkg, png);
            }
            return png;
        } catch (Exception e) {
            return null;
        }
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
        synchronized (icons) {
            icons.clear();
        }
        web.evaluateJavascript("window.__onResume&&window.__onResume()", null);
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.__onPause&&window.__onPause()", null);
        web.onPause();
        super.onPause();
    }

    /** window.Android.* — called from the page on a background thread. */
    public class Bridge {

        @JavascriptInterface
        public String listApps() {
            try {
                PackageManager pm = getPackageManager();
                Intent main = new Intent(Intent.ACTION_MAIN, null);
                main.addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> found = pm.queryIntentActivities(main, 0);
                List<String[]> rows = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                for (ResolveInfo ri : found) {
                    String pkg = ri.activityInfo.packageName;
                    if (pkg.equals(getPackageName()) || !seen.add(pkg)) continue;
                    rows.add(new String[]{ri.loadLabel(pm).toString(), pkg});
                }
                Collections.sort(rows, (a, b) -> a[0].compareToIgnoreCase(b[0]));
                JSONArray arr = new JSONArray();
                for (String[] r : rows) {
                    JSONObject o = new JSONObject();
                    o.put("label", r[0]);
                    o.put("package", r[1]);
                    arr.put(o);
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
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
    }
}
