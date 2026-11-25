package kr.kangdohyun.yorushika;

import android.app.SearchManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 스트리밍 앱 연동.
 * 알림 접근 권한을 받으면 안드로이드가 다른 앱(Spotify, YouTube Music 등)의 재생 세션을 보여 준다.
 * - 지금 재생 중인 곡·위치를 읽어 웹앱에 넘기고(가사 싱크·이야기 연결)
 * - 재생/일시정지/다음/탐색 명령을 그 앱에 보내고
 * - 웹앱이 넘긴 대기열을 '검색 재생'으로 한 곡씩 이어 준다. 이 서비스는 시스템이 계속 붙잡고 있어서
 *   화면이 꺼져 있어도 다음 곡으로 넘어갈 수 있다.
 */
public class ExtLink extends NotificationListenerService {
    static final String[] KNOWN = {
            "com.spotify.music", "com.google.android.apps.youtube.music",
            "com.google.android.youtube", "com.apple.android.music"};

    static volatile ExtLink inst;
    static volatile MediaController ctl;
    static final Object L = new Object();

    static class Item { String id, q, key, title; }

    static final List<Item> queue = new ArrayList<>();
    static int qi = -1;
    static boolean qActive = false, confirmed = false, failCounted = false, earlyFired = false;
    static String repeat = "off", target = "com.spotify.music", lastKey = "";
    static long reqAt = 0, lastPos = 0, lastDur = 0;
    static int fails = 0;

    private Handler h;
    private MediaSessionManager msm;
    private MediaSessionManager.OnActiveSessionsChangedListener sl;

    private final MediaController.Callback cb = new MediaController.Callback() {
        @Override public void onMetadataChanged(MediaMetadata m) { onTrack(); }
        @Override public void onPlaybackStateChanged(PlaybackState s) { }
        @Override public void onSessionDestroyed() { pick(null); }
    };

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            try { step(); } catch (Exception ignored) { }
            if (h != null) h.postDelayed(this, 500);
        }
    };

    static ComponentName comp(Context c) { return new ComponentName(c, ExtLink.class); }

    static boolean access(Context c) {
        String s = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        boolean ok = s != null && s.contains(c.getPackageName());
        if (ok && inst == null) try { NotificationListenerService.requestRebind(comp(c)); } catch (Exception ignored) { }
        return ok;
    }

    static void openAccess(Context c) {
        Intent i;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, comp(c).flattenToString());
        } else {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(i); } catch (Exception e) {
            try { c.startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
        }
    }

    @Override
    public void onListenerConnected() {
        inst = this;
        h = new Handler(Looper.getMainLooper());
        msm = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
        sl = this::pick;
        try {
            msm.addOnActiveSessionsChangedListener(sl, comp(this));
            pick(msm.getActiveSessions(comp(this)));
        } catch (Exception ignored) { }
        h.removeCallbacks(tick);
        h.post(tick);
    }

    @Override
    public void onListenerDisconnected() {
        try { if (msm != null && sl != null) msm.removeOnActiveSessionsChangedListener(sl); } catch (Exception ignored) { }
        if (h != null) h.removeCallbacks(tick);
        MediaController c = ctl;
        if (c != null) try { c.unregisterCallback(cb); } catch (Exception ignored) { }
        ctl = null;
        inst = null;
    }

    /** 가장 알맞은 외부 재생 세션 고르기: 재생 중인 것 > 연동 앱으로 고른 것 > 알려진 음악 앱 > 그 밖 */
    void pick(List<MediaController> list) {
        try {
            if (list == null) list = msm.getActiveSessions(comp(this));
        } catch (Exception e) { return; }
        MediaController best = null;
        int bs = -1;
        for (MediaController c : list) {
            if (getPackageName().equals(c.getPackageName())) continue;
            int s = 0;
            PlaybackState ps = c.getPlaybackState();
            if (ps != null && ps.getState() == PlaybackState.STATE_PLAYING) s += 100;
            if (c.getPackageName().equals(target)) s += 20;
            for (String k : KNOWN) if (k.equals(c.getPackageName())) s += 10;
            if (s > bs) { bs = s; best = c; }
        }
        MediaController old = ctl;
        if (old != null && best != null && old.getSessionToken().equals(best.getSessionToken())) return;
        if (old != null) try { old.unregisterCallback(cb); } catch (Exception ignored) { }
        ctl = best;
        if (best != null) {
            try { best.registerCallback(cb, h); } catch (Exception ignored) { }
            onTrack();
        }
    }

    static long pos(MediaController c) {
        PlaybackState ps = c.getPlaybackState();
        if (ps == null) return 0;
        long p = ps.getPosition();
        if (ps.getState() == PlaybackState.STATE_PLAYING && ps.getLastPositionUpdateTime() > 0)
            p += (long) ((SystemClock.elapsedRealtime() - ps.getLastPositionUpdateTime()) * ps.getPlaybackSpeed());
        return Math.max(0, p);
    }

    static long dur(MediaController c) {
        MediaMetadata m = c.getMetadata();
        return m == null ? 0 : Math.max(0, m.getLong(MediaMetadata.METADATA_KEY_DURATION));
    }

    static String str(MediaMetadata m, String k) {
        if (m == null) return "";
        CharSequence s = m.getText(k);
        return s == null ? "" : s.toString();
    }

    private static final Pattern P1 = Pattern.compile("(?i)\\(re-?recording\\)|ヨルシカ|yorushika|official|music ?video|mv|audio|full");
    private static final Pattern P2 = Pattern.compile("[\\s_\\-–—・·、。.,!！?？「」『』()（）\\[\\]【】'\"`~]");

    /** app.js 의 norm()과 같은 규칙 */
    static String norm(String s) {
        if (s == null) return "";
        String t = Normalizer.normalize(s, Normalizer.Form.NFKC).toLowerCase();
        t = P1.matcher(t).replaceAll("");
        return P2.matcher(t).replaceAll("");
    }

    static boolean match(String ext, String key) {
        if (ext.isEmpty() || key == null || key.isEmpty()) return false;
        return ext.equals(key) || ext.startsWith(key) || (key.length() >= 2 && ext.contains(key));
    }

    static boolean isYoru(MediaMetadata m) {
        String a = (str(m, MediaMetadata.METADATA_KEY_ARTIST) + " " + str(m, MediaMetadata.METADATA_KEY_ALBUM_ARTIST) + " " + str(m, MediaMetadata.METADATA_KEY_ALBUM)).toLowerCase();
        return a.contains("ヨルシカ") || a.contains("yorushika") || a.contains("요루시카");
    }

    /** 곡이 바뀌었을 때: 대기열의 어느 곡인지 맞추고, 아니면 다음 곡으로 넘긴다 */
    void onTrack() {
        MediaController c = ctl;
        if (c == null) return;
        MediaMetadata m = c.getMetadata();
        String key = norm(str(m, MediaMetadata.METADATA_KEY_TITLE));
        if (key.isEmpty() || key.equals(lastKey)) return;
        boolean nearEnd = lastDur > 10000 && lastPos >= lastDur - 8000;
        lastKey = key;
        synchronized (L) {
            if (!qActive || queue.isEmpty() || qi < 0) return;
            if (match(key, queue.get(qi).key)) { confirmed = true; fails = 0; return; }
            if (System.currentTimeMillis() - reqAt < 6000) return;      // 요청한 곡이 아직 뜨기 전
            int j = -1;
            for (int i = 0; i < queue.size(); i++) if (match(key, queue.get(i).key)) { j = i; break; }
            if (j >= 0) { qi = j; confirmed = true; earlyFired = false; return; }
            if (!nearEnd && isYoru(m)) { qActive = false; return; }     // 연동 앱에서 다른 요루시카 곡을 직접 고름
            advance();                                                   // 곡이 끝났거나 넘겨짐 → 다음 곡
        }
    }

    /** 0.5초마다: 위치 기록, 곡이 끝나기 직전이면 다음 곡을 미리 요청 */
    void step() {
        MediaController c = ctl;
        if (c == null) return;
        long d = dur(c), p = pos(c);
        lastPos = p; lastDur = d;
        PlaybackState ps = c.getPlaybackState();
        boolean playing = ps != null && ps.getState() == PlaybackState.STATE_PLAYING;
        synchronized (L) {
            if (!qActive) return;
            long since = System.currentTimeMillis() - reqAt;
            if (!confirmed && since > 6000 && !failCounted) {
                failCounted = true;
                if (++fails >= 3) { qActive = false; return; }           // 검색 재생이 계속 실패하면 관리 중단
            }
            if (playing && confirmed && d > 10000 && p >= d - 900 && !earlyFired && since > 6000) {
                earlyFired = true;
                advance();
            }
        }
    }

    void advance() {
        if ("one".equals(repeat)) { play(this, qi); return; }
        int n = qi + 1;
        if (n >= queue.size()) {
            if ("all".equals(repeat)) n = 0;
            else { qActive = false; return; }
        }
        play(this, n);
    }

    static Bundle extras(Item it) {
        Bundle b = new Bundle();
        b.putString(SearchManager.QUERY, it.q);
        b.putString(MediaStore.EXTRA_MEDIA_FOCUS, MediaStore.Audio.Media.ENTRY_CONTENT_TYPE);
        b.putString(MediaStore.EXTRA_MEDIA_TITLE, it.title);
        b.putString(MediaStore.EXTRA_MEDIA_ARTIST, "ヨルシカ");
        return b;
    }

    /** i번째 곡 재생 요청. 반환: session(앱 안에서 바로) / intent(앱을 열어 재생) / search(검색 화면) / noapp */
    static String play(Context cx, int i) {
        Item it;
        synchronized (L) {
            if (i < 0 || i >= queue.size()) return "none";
            qi = i; reqAt = System.currentTimeMillis(); confirmed = false; failCounted = false; earlyFired = false; qActive = true;
            it = queue.get(i);
        }
        MediaController c = ctl;
        if (c == null || !target.equals(c.getPackageName())) {
            ExtLink s = inst;
            if (s != null) s.pick(null);
            c = ctl;
        }
        if (c != null && target.equals(c.getPackageName())) {
            try { c.getTransportControls().playFromSearch(it.q, extras(it)); return "session"; } catch (Exception ignored) { }
        }
        PackageManager pm = cx.getPackageManager();
        try { pm.getApplicationInfo(target, 0); } catch (Exception e) { return "noapp"; }
        Intent in = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
        in.setPackage(target);
        in.putExtras(extras(it));
        in.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (in.resolveActivity(pm) != null) { cx.startActivity(in); return "intent"; }
        } catch (Exception ignored) { }
        try {
            Intent v;
            if ("com.spotify.music".equals(target)) v = new Intent(Intent.ACTION_VIEW, Uri.parse("spotify:search:" + Uri.encode(it.q)));
            else if ("com.google.android.apps.youtube.music".equals(target)) v = new Intent(Intent.ACTION_VIEW, Uri.parse("https://music.youtube.com/search?q=" + Uri.encode(it.q)));
            else v = pm.getLaunchIntentForPackage(target);
            if (v == null) return "noapp";
            v.setPackage(target);
            v.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            cx.startActivity(v);
            return "search";
        } catch (Exception e) {
            return "noapp";
        }
    }

    // ----- 웹앱 브리지에서 부르는 정적 함수 -----

    static String setQueue(Context cx, String json, int index, String rep, String pkg, boolean playNow) {
        synchronized (L) {
            queue.clear();
            try {
                JSONArray a = new JSONArray(json);
                for (int i = 0; i < a.length(); i++) {
                    JSONObject o = a.getJSONObject(i);
                    Item it = new Item();
                    it.id = o.optString("id"); it.q = o.optString("q"); it.key = o.optString("key"); it.title = o.optString("title");
                    queue.add(it);
                }
            } catch (Exception e) { return "error"; }
            repeat = rep == null ? "off" : rep;
            if (pkg != null && !pkg.isEmpty()) target = pkg;
            qi = Math.max(0, Math.min(index, queue.size() - 1));
            if (!playNow) { qActive = !queue.isEmpty(); confirmed = true; return "ok"; }
        }
        if (!access(cx)) return "noaccess";
        return play(cx, index);
    }

    static void stopQueue() { synchronized (L) { qActive = false; } }

    static void setRepeat(String r) { synchronized (L) { repeat = r == null ? "off" : r; } }

    static void control(String a, long ms) {
        MediaController c = ctl;
        if (c == null) return;
        MediaController.TransportControls t = c.getTransportControls();
        try {
            switch (a) {
                case "play": t.play(); break;
                case "pause": t.pause(); break;
                case "next": t.skipToNext(); break;
                case "prev": t.skipToPrevious(); break;
                case "seek": t.seekTo(Math.max(0, ms)); break;
                default: break;
            }
        } catch (Exception ignored) { }
    }

    static String label(Context cx, String pkg) {
        try {
            PackageManager pm = cx.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(ai).toString();
        } catch (Exception e) { return ""; }
    }

    static String apps(Context cx) {
        JSONArray a = new JSONArray();
        for (String k : KNOWN) {
            String l = label(cx, k);
            if (!l.isEmpty()) try { a.put(new JSONObject().put("pkg", k).put("label", l)); } catch (Exception ignored) { }
        }
        return a.toString();
    }

    static void openApp(Context cx, String pkg) {
        try {
            Intent i = cx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); cx.startActivity(i); }
        } catch (Exception ignored) { }
    }

    static String state(Context cx) {
        try {
            JSONObject o = new JSONObject();
            o.put("access", access(cx));
            o.put("connected", inst != null);
            MediaController c = ctl;
            if (c != null) {
                MediaMetadata m = c.getMetadata();
                PlaybackState ps = c.getPlaybackState();
                o.put("pkg", c.getPackageName());
                o.put("app", label(cx, c.getPackageName()));
                o.put("title", str(m, MediaMetadata.METADATA_KEY_TITLE));
                o.put("artist", str(m, MediaMetadata.METADATA_KEY_ARTIST));
                o.put("album", str(m, MediaMetadata.METADATA_KEY_ALBUM));
                o.put("dur", dur(c));
                o.put("pos", pos(c));
                o.put("playing", ps != null && ps.getState() == PlaybackState.STATE_PLAYING);
            }
            synchronized (L) {
                JSONObject q = new JSONObject();
                q.put("active", qActive);
                q.put("index", qi);
                q.put("id", qi >= 0 && qi < queue.size() ? queue.get(qi).id : "");
                q.put("confirmed", confirmed);
                q.put("fails", fails);
                o.put("q", q);
            }
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
