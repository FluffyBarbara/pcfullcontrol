'use strict';
// Добавляет в AndroidManifest.xml виджет «Мой ПК», окно его кнопок и разрешение на микрофон.
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'];
for (const p of perms) {
  if (!s.includes(p)) s = s.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
}
if (!s.includes('PcWidgetProvider')) {
  s = s.replace('</application>', `        <receiver android:name=".PcWidgetProvider" android:exported="false" android:label="Мой ПК">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/pc_widget_info" />
        </receiver>
        <activity android:name=".WidgetActionActivity" android:exported="false" android:excludeFromRecents="true"
            android:taskAffinity="" android:noHistory="true" android:theme="@android:style/Theme.Translucent.NoTitleBar" />
    </application>`);
}
// Данные приложения (адрес ПК, ключ доступа в хранилище WebView) не попадают в облачные копии
// и при переносе на другой телефон
s = s.replace(/\s*android:allowBackup="[^"]*"/, '').replace(/\s*android:fullBackupContent="[^"]*"/, '').replace(/\s*android:dataExtractionRules="[^"]*"/, '');
s = s.replace('<application', '<application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules"');
fs.writeFileSync(file, s);
console.log('Манифест: виджет и микрофон добавлены');
