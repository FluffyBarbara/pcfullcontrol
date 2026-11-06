package com.pcfullcontrol.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Виджет «Мой ПК» на главном экране: загрузка, температуры, что играет, кнопки. Данные — с ПК по Wi-Fi. */
public class PcWidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.pcfullcontrol.mobile.WIDGET_REFRESH";
    static final String PREFS = "pcfc_widget";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(a) || ACTION_REFRESH.equals(a)) {
            final PendingResult pr = goAsync();
            final Context app = ctx.getApplicationContext();
            render(app, null, "обновляю…");
            new Thread(() -> {
                try { refreshNow(app); } finally { pr.finish(); }
            }).start();
            return;
        }
        super.onReceive(ctx, intent);
    }

    /** Обновить все виджеты (вызывается из приложения после настройки). */
    static void requestUpdate(Context ctx) {
        Intent i = new Intent(ctx, PcWidgetProvider.class);
        i.setAction(ACTION_REFRESH);
        ctx.sendBroadcast(i);
    }

    static void refreshNow(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = p.getString("url", "");
        String key = p.getString("key", "");
        if (base.isEmpty() || key.isEmpty()) {
            render(ctx, null, "Откройте приложение → Ещё → Виджет");
            return;
        }
        HttpURLConnection c = null;
        try {
            URL u = new URL(base + "/api/widget?k=" + URLEncoder.encode(key, "UTF-8"));
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(6000);
            int code = c.getResponseCode();
            if (code == 401) { render(ctx, null, "Виджет отключён — добавьте его заново"); return; }
            if (code != 200) { render(ctx, null, "ПК ответил ошибкой " + code); return; }
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            JSONObject j = new JSONObject(sb.toString());
            render(ctx, j, null);
        } catch (Exception e) {
            render(ctx, null, "не в сети");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String num(JSONObject j, String k, String suffix) {
        return j.isNull(k) ? "—" : j.optInt(k) + suffix;
    }

    static void render(Context ctx, JSONObject j, String status) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.pc_widget);
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String name = p.getString("name", "Мой ПК");
        if (j != null) {
            name = j.optString("pcName", name);
            v.setTextViewText(R.id.w_status, "● в сети");
            v.setTextColor(R.id.w_status, Color.parseColor("#34D399"));
            String cpu = "ЦП " + num(j, "cpu", "%") + (j.isNull("cpuTemp") ? "" : " · " + j.optInt("cpuTemp") + "°");
            v.setTextViewText(R.id.w_cpu, cpu);
            v.setTextViewText(R.id.w_ram, "ОЗУ " + num(j, "ram", "%"));
            if (j.isNull("gpuTemp")) v.setViewVisibility(R.id.w_gpu, View.GONE);
            else { v.setViewVisibility(R.id.w_gpu, View.VISIBLE); v.setTextViewText(R.id.w_gpu, "Видео " + j.optInt("gpuTemp") + "°" + (j.isNull("gpuUtil") ? "" : " · " + j.optInt("gpuUtil") + "%")); }
            JSONObject m = j.optJSONObject("media");
            if (m != null && m.optString("title", "").length() > 0) {
                String artist = m.optString("artist", "");
                v.setViewVisibility(R.id.w_media, View.VISIBLE);
                v.setTextViewText(R.id.w_media, (m.optBoolean("playing") ? "▶ " : "⏸ ") + (artist.isEmpty() ? "" : artist + " — ") + m.optString("title"));
            } else v.setViewVisibility(R.id.w_media, View.GONE);
            v.setTextViewText(R.id.w_time, "обновлено " + new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date()));
        } else {
            v.setTextViewText(R.id.w_status, "● " + status);
            v.setTextColor(R.id.w_status, Color.parseColor(status != null && status.startsWith("обновляю") ? "#8F98AD" : "#FF5D6C"));
            v.setTextViewText(R.id.w_time, "");
        }
        v.setTextViewText(R.id.w_name, name);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent refresh = new Intent(ctx, PcWidgetProvider.class).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.w_refresh, PendingIntent.getBroadcast(ctx, 1, refresh, flags));
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) v.setOnClickPendingIntent(R.id.w_head, PendingIntent.getActivity(ctx, 2, open, flags));
        v.setOnClickPendingIntent(R.id.w_lock, action(ctx, "lock", 3));
        v.setOnClickPendingIntent(R.id.w_play, action(ctx, "play_pause", 4));
        v.setOnClickPendingIntent(R.id.w_sleep, action(ctx, "sleep", 5));
        v.setOnClickPendingIntent(R.id.w_power, action(ctx, "shutdown", 6));

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        mgr.updateAppWidget(new ComponentName(ctx, PcWidgetProvider.class), v);
    }

    static PendingIntent action(Context ctx, String act, int code) {
        Intent i = new Intent(ctx, WidgetActionActivity.class);
        i.putExtra("action", act);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        return PendingIntent.getActivity(ctx, 100 + code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
