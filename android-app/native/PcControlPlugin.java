package com.pcfullcontrol.mobile;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.speech.tts.TextToSpeech;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

/** Виджет на главном экране и озвучка ответов голосового ассистента. */
@CapacitorPlugin(name = "PcControl")
public class PcControlPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String pendingText = null;

    @PluginMethod
    public void saveWidget(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences p = ctx.getSharedPreferences(PcWidgetProvider.PREFS, Context.MODE_PRIVATE);
        p.edit().putString("url", call.getString("url", "")).putString("key", call.getString("key", "")).putString("name", call.getString("name", "Мой ПК")).apply();
        PcWidgetProvider.requestUpdate(ctx);
        boolean pinRequested = false;
        Boolean pin = call.getBoolean("pin", true);
        if (pin != null && pin && Build.VERSION.SDK_INT >= 26) {
            AppWidgetManager m = AppWidgetManager.getInstance(ctx);
            if (m.isRequestPinAppWidgetSupported()) {
                pinRequested = m.requestPinAppWidget(new ComponentName(ctx, PcWidgetProvider.class), null, null);
            }
        }
        JSObject r = new JSObject();
        r.put("pinRequested", pinRequested);
        call.resolve(r);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        if (tts == null) {
            pendingText = text;
            tts = new TextToSpeech(getContext(), status -> {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    tts.setLanguage(new Locale("ru", "RU"));
                    if (pendingText != null) tts.speak(pendingText, TextToSpeech.QUEUE_FLUSH, null, "pcfc");
                    pendingText = null;
                }
            });
        } else if (ttsReady) {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pcfc");
        } else {
            pendingText = text;
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) { tts.shutdown(); tts = null; }
        super.handleOnDestroy();
    }
}
