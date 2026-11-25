package kr.kangdohyun.yorushika;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.webkit.WebViewAssetLoader;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** 웹앱 화면을 띄우고, 재생 명령은 PlaybackService로 넘긴다. */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final int REQ_FILE = 42, REQ_NOTIFY = 7;

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ListenableFuture<MediaController> future;
    private MediaController ctl;
    private final List<Runnable> pending = new ArrayList<>();
    private ValueCallback<Uri[]> fileCb;

    // 웹 쪽에서 다른 스레드로 읽어 가는 재생 상태
    private volatile int sCount = 0, sIndex = -1;
    private volatile String sId = null, sQueue = "[]";
    private volatile long sPos = 0, sDur = 0, sAt = 0;
    private volatile boolean sPlaying = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Store.channels(this);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                if (!r.isForMainFrame()) return false; // YouTube 영상 iframe 등 하위 프레임은 앱 안에서 연다
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                boolean audio = false;
                String[] acc = p.getAcceptTypes();
                if (acc != null) for (String a : acc) if (a != null && a.startsWith("audio")) audio = true;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(audio ? "audio/*" : "*/*");
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, audio ? "음원 파일 선택" : "파일 선택"), REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "YoruNative");
        web.loadUrl("https://" + HOST + "/assets/www/index.html");

        SessionToken token = new SessionToken(this, new ComponentName(this, PlaybackService.class));
        future = new MediaController.Builder(this, token).buildAsync();
        future.addListener(() -> {
            try {
                ctl = future.get();
                ctl.addListener(new Player.Listener() {
                    @Override
                    public void onEvents(Player player, Player.Events events) {
                        snap();
                    }
                });
                snap();
                for (Runnable r : pending) r.run();
                pending.clear();
            } catch (Exception ignored) {
            }
        }, ContextCompat.getMainExecutor(this));

        ui.post(tick);

        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(ReleaseWorker.class, 12, TimeUnit.HOURS)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("yoru-new", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            snap();
            ui.postDelayed(this, 500);
        }
    };

    /** 메인 스레드에서 플레이어 상태를 읽어 둔다. */
    private void snap() {
        MediaController c = ctl;
        if (c == null) return;
        sCount = c.getMediaItemCount();
        sIndex = c.getCurrentMediaItemIndex();
        MediaItem m = c.getCurrentMediaItem();
        sId = m == null ? null : m.mediaId;
        sPos = Math.max(0, c.getCurrentPosition());
        long d = c.getDuration();
        sDur = d == C.TIME_UNSET ? 0 : d;
        sPlaying = c.isPlaying();
        sAt = SystemClock.elapsedRealtime();
        JSONArray q = new JSONArray();
        for (int i = 0; i < sCount; i++) q.put(c.getMediaItemAt(i).mediaId);
        sQueue = q.toString();
    }

    private void onCtl(Runnable r) {
        ui.post(() -> {
            if (ctl != null) {
                r.run();
                snap();
            } else pending.add(r);
        });
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCb != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{data.getData()};
                }
            }
            fileCb.onReceiveValue(out);
            fileCb = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /** 뒤로 가기: 앱 안의 화면을 먼저 닫고, 더 닫을 게 없으면 앱을 끄지 않고 뒤로 보낸다. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.yoruBack&&window.yoruBack())?'1':'0'", v -> {
            if (!"\"1\"".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onStop() {
        super.onStop();
        // YouTube 공식 영상 재생은 화면이 꺼지거나 앱을 나가면 멈춘다(백그라운드 재생 불가)
        if (web != null) web.evaluateJavascript("window.yoruBg&&window.yoruBg()", null);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(tick);
        if (future != null) MediaController.releaseFuture(future);
        ctl = null;
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** 웹앱(app.js)에서 window.YoruNative 로 부르는 함수들 */
    public class Bridge {
        private final Map<String, FileOutputStream> outs = new HashMap<>();

        @JavascriptInterface public boolean isNative() { return true; }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        // ----- 음원 파일 -----
        @JavascriptInterface
        public String listFiles() {
            JSONArray a = new JSONArray();
            File[] fs = Store.dir(MainActivity.this).listFiles();
            if (fs != null) for (File f : fs) if (!f.getName().endsWith(".part")) a.put(f.getName());
            return a.toString();
        }

        @JavascriptInterface
        public synchronized boolean fileBegin(String id) {
            try {
                close(id);
                outs.put(id, new FileOutputStream(new File(Store.dir(MainActivity.this), Store.name(id) + ".part")));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean fileChunk(String id, String b64) {
            try {
                FileOutputStream o = outs.get(id);
                if (o == null) return false;
                o.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean fileEnd(String id) {
            close(id);
            File part = new File(Store.dir(MainActivity.this), Store.name(id) + ".part");
            File f = Store.file(MainActivity.this, id);
            if (f.exists()) f.delete();
            return part.renameTo(f);
        }

        private void close(String id) {
            FileOutputStream o = outs.remove(id);
            if (o != null) try {
                o.close();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public boolean deleteFile(String id) {
            return Store.file(MainActivity.this, id).delete();
        }

        @JavascriptInterface
        public boolean clearFiles() {
            onCtl(() -> {
                ctl.stop();
                ctl.clearMediaItems();
            });
            File[] fs = Store.dir(MainActivity.this).listFiles();
            if (fs != null) for (File f : fs) f.delete();
            Store.saveQueue(MainActivity.this, "[]", 0, 0);
            return true;
        }

        // ----- 재생 -----
        @JavascriptInterface
        public void setQueue(String json, int index, long posMs, boolean play) {
            Store.saveQueue(MainActivity.this, json, index, posMs);
            final List<MediaItem> items = Store.items(json);
            if (items.isEmpty()) return;
            final int start = Math.max(0, Math.min(index, items.size() - 1));
            onCtl(() -> {
                ctl.setMediaItems(items, start, Math.max(0, posMs));
                ctl.prepare();
                ctl.setPlayWhenReady(play);
            });
        }

        @JavascriptInterface
        public void play() {
            onCtl(() -> {
                if (ctl.getPlaybackState() == Player.STATE_IDLE) ctl.prepare();
                if (ctl.getPlaybackState() == Player.STATE_ENDED) ctl.seekTo(0, 0);
                ctl.play();
            });
        }

        @JavascriptInterface public void pause() { onCtl(() -> ctl.pause()); }

        @JavascriptInterface
        public void next() {
            onCtl(() -> {
                if (ctl.hasNextMediaItem()) ctl.seekToNextMediaItem();
                else if (ctl.getMediaItemCount() > 0) ctl.seekTo(0, 0);
            });
        }

        @JavascriptInterface public void prev() { onCtl(() -> ctl.seekToPrevious()); }

        @JavascriptInterface public void seek(long ms) { onCtl(() -> ctl.seekTo(Math.max(0, ms))); }

        @JavascriptInterface
        public void setRepeat(String mode) {
            final int m = "one".equals(mode) ? Player.REPEAT_MODE_ONE
                    : "all".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF;
            onCtl(() -> ctl.setRepeatMode(m));
        }

        @JavascriptInterface
        public String getState() {
            long pos = sPos;
            if (sPlaying) pos += SystemClock.elapsedRealtime() - sAt;
            if (sDur > 0) pos = Math.min(pos, sDur);
            try {
                JSONObject o = new JSONObject();
                o.put("count", sCount);
                o.put("index", sIndex);
                o.put("id", sId == null ? JSONObject.NULL : sId);
                o.put("pos", pos);
                o.put("dur", sDur);
                o.put("playing", sPlaying);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface public String getQueue() { return sQueue; }

        // ----- 알림 -----
        @JavascriptInterface
        public void pushNote(String title, String body) {
            Store.notifyRelease(MainActivity.this, title, body);
        }

        @JavascriptInterface
        public void requestNotify() {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ui.post(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY));
            }
        }

        @JavascriptInterface
        public boolean notifyAllowed() {
            return Build.VERSION.SDK_INT < 33
                    || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }

        // ----- 스트리밍 앱 연동 (ExtLink) -----
        @JavascriptInterface public String extState() { return ExtLink.state(MainActivity.this); }
        @JavascriptInterface public boolean extAccess() { return ExtLink.access(MainActivity.this); }
        @JavascriptInterface public void extOpenAccess() { ExtLink.openAccess(MainActivity.this); }
        @JavascriptInterface public String extApps() { return ExtLink.apps(MainActivity.this); }
        @JavascriptInterface public void extOpenApp(String pkg) { ExtLink.openApp(MainActivity.this, pkg); }
        @JavascriptInterface
        public String extSetQueue(String json, int index, String rep, String pkg, boolean play) {
            return ExtLink.setQueue(MainActivity.this, json, index, rep, pkg, play);
        }
        @JavascriptInterface public void extStopQueue() { ExtLink.stopQueue(); }
        @JavascriptInterface public void extSetRepeat(String r) { ExtLink.setRepeat(r); }
        @JavascriptInterface public void extControl(String a, long ms) { ExtLink.control(a, ms); }

        @JavascriptInterface
        public void setReleaseState(String since, String seenJson) {
            Store.prefs(MainActivity.this).edit().putString("since", since).putString("seen", seenJson).apply();
        }
    }
}
