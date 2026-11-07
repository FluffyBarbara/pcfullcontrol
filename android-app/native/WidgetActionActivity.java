package com.pcfullcontrol.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Кнопка на виджете: выключение и сон — с подтверждением, остальное — сразу. */
public class WidgetActionActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final String action = getIntent().getStringExtra("action");
        if (action == null) { finish(); return; }
        if ("shutdown".equals(action) || "sleep".equals(action) || "reboot".equals(action)) {
            new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("shutdown".equals(action) ? "Выключить компьютер?" : "reboot".equals(action) ? "Перезагрузить компьютер?" : "Перевести компьютер в сон?")
                .setPositiveButton("shutdown".equals(action) ? "Выключить" : "reboot".equals(action) ? "Перезагрузить" : "Сон", (d, w) -> run(action))
                .setNegativeButton("Отмена", (d, w) -> finish())
                .setOnCancelListener((d) -> finish())
                .show();
        } else {
            run(action);
        }
    }

    private void run(final String action) {
        final Context app = getApplicationContext();
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String msg;
            HttpURLConnection c = null;
            try {
                SharedPreferences p = app.getSharedPreferences(PcWidgetProvider.PREFS, Context.MODE_PRIVATE);
                // Ключ виджета — в заголовке, а не в адресе (адреса попадают в журналы и историю)
                URL u = new URL(p.getString("url", "") + "/api/widget/action");
                c = (HttpURLConnection) u.openConnection();
                c.setRequestProperty("X-Widget-Key", p.getString("key", ""));
                c.setConnectTimeout(4000);
                c.setReadTimeout(15000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                OutputStream os = c.getOutputStream();
                // confirm: выключение, перезагрузку и сон пользователь уже подтвердил в окне выше
                os.write(("{\"action\":\"" + action + "\",\"confirm\":true}").getBytes("UTF-8"));
                os.close();
                int code = c.getResponseCode();
                msg = code == 200 ? "Готово ✓" : (code == 401 ? "Виджет отключён — добавьте его заново в приложении" : "Ошибка " + code);
            } catch (Exception e) {
                msg = "Компьютер не в сети";
            } finally {
                if (c != null) c.disconnect();
            }
            final String text = msg;
            ui.post(() -> {
                Toast.makeText(app, text, Toast.LENGTH_SHORT).show();
                PcWidgetProvider.requestUpdate(app);
                finish();
            });
        }).start();
    }
}
