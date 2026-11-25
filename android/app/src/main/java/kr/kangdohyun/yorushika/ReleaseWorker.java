package kr.kangdohyun.yorushika;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 앱이 꺼져 있어도 하루 두 번 Apple Music 공개 정보로 새 발매를 확인해 알린다. */
public class ReleaseWorker extends Worker {
    static final long ARTIST = 1250709916L;

    public ReleaseWorker(@NonNull Context c, @NonNull WorkerParameters p) {
        super(c, p);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        SharedPreferences p = Store.prefs(c);
        String since = p.getString("since", "2026-11-25");
        Set<String> seen = new HashSet<>();
        try {
            JSONArray a = new JSONArray(p.getString("seen", "[]"));
            for (int i = 0; i < a.length(); i++) seen.add(a.getString(i));
        } catch (Exception ignored) {
        }
        Set<String> told = new HashSet<>(p.getStringSet("told", new HashSet<>()));
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL("https://itunes.apple.com/lookup?id=" + ARTIST
                    + "&entity=album&limit=200&country=jp&lang=ja_jp").openConnection();
            h.setConnectTimeout(15000);
            h.setReadTimeout(20000);
            String body = new String(Store.readAll(h.getInputStream()), StandardCharsets.UTF_8);
            JSONArray rs = new JSONObject(body).getJSONArray("results");
            List<String> fresh = new ArrayList<>();
            for (int i = 0; i < rs.length(); i++) {
                JSONObject o = rs.getJSONObject(i);
                if (!"collection".equals(o.optString("wrapperType"))) continue;
                if (o.optLong("artistId") != ARTIST) continue;
                String key = "it" + o.optLong("collectionId");
                String d = o.optString("releaseDate", "");
                if (d.length() >= 10) d = d.substring(0, 10);
                if (d.compareTo(since) <= 0 || seen.contains(key) || told.contains(key)) continue;
                fresh.add(o.optString("collectionName").replaceAll("\\s*-\\s*(Single|EP)$", ""));
                told.add(key);
            }
            if (!fresh.isEmpty()) {
                p.edit().putStringSet("told", told).apply();
                Store.notifyRelease(c, "요루시카 새 발매",
                        "「" + TextUtils.join("」, 「", fresh) + "」 — 앱을 열면 목록에 들어와요");
            }
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        } finally {
            if (h != null) h.disconnect();
        }
    }
}
