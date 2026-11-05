package com.pcfullcontrol.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

/** Включение компьютера по сети: «волшебный пакет» Wake-on-LAN на широковещательный адрес домашней сети. */
@CapacitorPlugin(name = "WakeOnLan")
public class WakeOnLanPlugin extends Plugin {

    @PluginMethod
    public void wake(PluginCall call) {
        final String mac = call.getString("mac", "");
        final String broadcast = call.getString("broadcast", "255.255.255.255");
        new Thread(() -> {
            try {
                String hex = mac.replaceAll("[^0-9A-Fa-f]", "");
                if (hex.length() != 12) {
                    call.reject("Неверный MAC-адрес");
                    return;
                }
                byte[] macBytes = new byte[6];
                for (int i = 0; i < 6; i++) {
                    macBytes[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
                }
                byte[] packet = new byte[6 + 16 * 6];
                for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
                for (int i = 6; i < packet.length; i += 6) System.arraycopy(macBytes, 0, packet, i, 6);

                String[] targets = broadcast.equals("255.255.255.255")
                        ? new String[] { "255.255.255.255" }
                        : new String[] { broadcast, "255.255.255.255" };
                int[] ports = { 9, 7 };
                DatagramSocket socket = new DatagramSocket();
                socket.setBroadcast(true);
                for (int attempt = 0; attempt < 3; attempt++) {
                    for (String target : targets) {
                        InetAddress address = InetAddress.getByName(target);
                        for (int port : ports) {
                            socket.send(new DatagramPacket(packet, packet.length, address, port));
                        }
                    }
                    Thread.sleep(150);
                }
                socket.close();
                JSObject ret = new JSObject();
                ret.put("sent", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Не удалось отправить сигнал включения: " + e.getMessage());
            }
        }).start();
    }
}
