package com.pcfullcontrol.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WakeOnLanPlugin.class);
        registerPlugin(PcControlPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
