package kr.kangdohyun.yorushika;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.session.MediaSession;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 음원 파일, 재생 대기열, 알림을 한곳에서 다룬다. */
final class Store {
    private Store() {}

    static final String PREFS = "yoru";
    static final String CH_RELEASES = "releases";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- 음원 파일 ----------
    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "audio");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static String name(String id) {
        return id.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    static File file(Context c, String id) {
        return new File(dir(c), name(id));
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    // ---------- 앨범 아트 ----------
    private static final Map<String, byte[]> ART = new HashMap<>();

    static byte[] art(Context c, String key) {
        String k = (key == null || key.isEmpty()) ? "icon" : key;
        synchronized (ART) {
            if (ART.containsKey(k)) return ART.get(k);
        }
        byte[] b = null;
        String path = k.equals("icon") ? "www/icon-512.png" : "www/art/" + k + ".png";
        try (InputStream in = c.getAssets().open(path)) {
            b = readAll(in);
        } catch (Exception e) {
            if (!k.equals("icon")) b = art(c, "icon");
        }
        synchronized (ART) {
            ART.put(k, b);
        }
        return b;
    }

    // ---------- 대기열 ----------
    static List<MediaItem> items(String json) {
        List<MediaItem> list = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(json);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                Bundle extras = new Bundle();
                extras.putString("art", o.optString("art", ""));
                MediaMetadata md = new MediaMetadata.Builder()
                        .setTitle(o.optString("title"))
                        .setArtist(o.optString("artist"))
                        .setAlbumTitle(o.optString("album"))
                        .setExtras(extras)
                        .build();
                list.add(new MediaItem.Builder()
                        .setMediaId(o.getString("id"))
                        .setMediaMetadata(md)
                        .build());
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    /** 컨트롤러가 보낸 항목에 실제 파일 경로와 아트를 붙인다. */
    static MediaItem resolve(Context c, MediaItem m) {
        MediaMetadata md = m.mediaMetadata;
        String key = md.extras != null ? md.extras.getString("art") : null;
        MediaMetadata.Builder mb = md.buildUpon();
        byte[] a = art(c, key);
        if (a != null) mb.setArtworkData(a, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
        return m.buildUpon()
                .setUri(Uri.fromFile(file(c, m.mediaId)))
                .setMediaMetadata(mb.build())
                .build();
    }

    static void saveQueue(Context c, String json, int index, long posMs) {
        prefs(c).edit().putString("q", json).putInt("i", index).putLong("pos", posMs).apply();
    }

    static void savePos(Context c, int index, long posMs) {
        prefs(c).edit().putInt("i", Math.max(0, index)).putLong("pos", Math.max(0, posMs)).apply();
    }

    /** 앱이 꺼진 뒤 버즈나 잠금화면에서 재생을 누르면 마지막 대기열을 되살린다. */
    static MediaSession.MediaItemsWithStartPosition resumption(Context c) {
        SharedPreferences p = prefs(c);
        List<MediaItem> out = new ArrayList<>();
        for (MediaItem m : items(p.getString("q", "[]"))) {
            if (file(c, m.mediaId).exists()) out.add(resolve(c, m));
        }
        if (out.isEmpty()) return new MediaSession.MediaItemsWithStartPosition(out, C.INDEX_UNSET, C.TIME_UNSET);
        int i = Math.max(0, Math.min(p.getInt("i", 0), out.size() - 1));
        return new MediaSession.MediaItemsWithStartPosition(out, i, p.getLong("pos", 0));
    }

    // ---------- 새 발매 알림 ----------
    static void channels(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_RELEASES, "새 발매 알림", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("요루시카의 새 곡·앨범이 나오면 알려 줍니다");
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    static void notifyRelease(Context c, String title, String body) {
        channels(c);
        if (Build.VERSION.SDK_INT >= 33
                && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(c, CH_RELEASES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify((int) (System.currentTimeMillis() % 100000), n);
    }
}
