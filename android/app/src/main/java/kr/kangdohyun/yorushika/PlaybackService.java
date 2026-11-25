package kr.kangdohyun.yorushika;

import android.app.PendingIntent;
import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.ArrayList;
import java.util.List;

/**
 * 실제 재생을 맡는 백그라운드 서비스.
 * 화면(웹뷰)이 닫혀도 계속 재생하고, 알림창·잠금화면·버즈 입력을 처리한다.
 */
public class PlaybackService extends MediaSessionService {

    @Nullable private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();
        ExoPlayer player = new ExoPlayer.Builder(this)
                .setAudioAttributes(attrs, true)          // 전화·다른 앱 소리가 나면 잠시 멈춤
                .setHandleAudioBecomingNoisy(true)         // 이어폰·버즈 연결이 끊기면 일시정지
                .setWakeMode(C.WAKE_MODE_LOCAL)            // 화면이 꺼져도 CPU 유지
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
                Store.savePos(PlaybackService.this, player.getCurrentMediaItemIndex(), 0);
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (!isPlaying) Store.savePos(PlaybackService.this, player.getCurrentMediaItemIndex(), player.getCurrentPosition());
            }
        });

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        session = new MediaSession.Builder(this, player)
                .setSessionActivity(pi)
                .setCallback(new MediaSession.Callback() {
                    @Override
                    public ListenableFuture<List<MediaItem>> onAddMediaItems(
                            MediaSession s, MediaSession.ControllerInfo controller, List<MediaItem> items) {
                        List<MediaItem> out = new ArrayList<>();
                        for (MediaItem m : items) out.add(Store.resolve(PlaybackService.this, m));
                        return Futures.immediateFuture(out);
                    }

                    @Override
                    public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
                            MediaSession s, MediaSession.ControllerInfo controller) {
                        return Futures.immediateFuture(Store.resumption(PlaybackService.this));
                    }
                })
                .build();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /** 최근 앱 목록에서 밀어 꺼도, 재생 중이면 계속 재생한다. 멈춰 있을 때만 서비스를 끝낸다. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Player p = session != null ? session.getPlayer() : null;
        if (p == null || !p.getPlayWhenReady() || p.getMediaItemCount() == 0
                || p.getPlaybackState() == Player.STATE_ENDED) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            Player p = session.getPlayer();
            Store.savePos(this, p.getCurrentMediaItemIndex(), p.getCurrentPosition());
            p.release();
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
