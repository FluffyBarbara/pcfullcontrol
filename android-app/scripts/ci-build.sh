#!/usr/bin/env bash
# Сборка Android-приложения (запускается в GitHub Actions на Ubuntu).
#
# Подпись APK:
#  - если в секретах репозитория заданы ANDROID_KEYSTORE_BASE64 и ANDROID_KEYSTORE_PASSWORD
#    (а также необязательный ANDROID_KEY_ALIAS), APK подписывается этим ключом — тогда новые
#    версии ставятся поверх старых;
#  - иначе собирается debug-версия с отладочной подписью (при обновлении может понадобиться
#    удалить старую версию приложения).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_VERSION=$(node -p "require('../package.json').version")

npm ci --no-audit --no-fund
npm run prepare-web
rm -rf android
npx cap add android
npx cap sync android

RES=android/app/src/main/res
MAN=android/app/src/main/AndroidManifest.xml

# Разрешаем http в домашней сети и доступ к камере (сканер QR-кода)
grep -q 'usesCleartextTraffic' "$MAN" || sed -i 's|<application|<application android:usesCleartextTraffic="true"|' "$MAN"
grep -q 'android.permission.CAMERA' "$MAN" || sed -i 's|</manifest>|    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>|' "$MAN"

# Нативный модуль включения ПК по сети (Wake-on-LAN): веб-страница не умеет отправлять UDP-пакеты
JAVA_DIR=android/app/src/main/java/com/pcfullcontrol/mobile
mkdir -p "$JAVA_DIR"
cp native/WakeOnLanPlugin.java "$JAVA_DIR/"
cp native/MainActivity.java "$JAVA_DIR/"

# Значки приложения
cp -r icons/* "$RES/"
mkdir -p "$RES/mipmap-anydpi-v26" "$RES/values"
for f in ic_launcher ic_launcher_round; do
  cat > "$RES/mipmap-anydpi-v26/$f.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
XML
done
cat > "$RES/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#2563EB</color>
</resources>
XML

# Версия = версии программы на ПК
sed -i -E "s/versionCode [0-9]+/versionCode ${GITHUB_RUN_NUMBER:-1}/; s/versionName \"[^\"]*\"/versionName \"${ROOT_VERSION}\"/" android/app/build.gradle

echo "--- AndroidManifest.xml ---"
cat "$MAN"

mkdir -p ../dist-android
OUT=../dist-android/PCControl-Android.apk

if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ] && [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  echo "Подпись собственным ключом из секретов репозитория"
  (cd android && chmod +x gradlew && ./gradlew assembleRelease --no-daemon --stacktrace)
  KS=$(mktemp --suffix=.keystore)
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KS"
  BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
  "$BT/zipalign" -f -p 4 android/app/build/outputs/apk/release/app-release-unsigned.apk /tmp/aligned.apk
  "$BT/apksigner" sign --ks "$KS" --ks-key-alias "${ANDROID_KEY_ALIAS:-pcfc}" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEYSTORE_PASSWORD --out "$OUT" /tmp/aligned.apk
  rm -f "$KS"
  "$BT/apksigner" verify "$OUT"
else
  echo "Секреты подписи не заданы — собираю debug-версию"
  # Стандартный отладочный ключ Android (общеизвестные параметры). Хранится в кэше GitHub Actions,
  # чтобы все сборки были подписаны одинаково и обновления ставились поверх.
  mkdir -p "$HOME/.android"
  if [ ! -f "$HOME/.android/debug.keystore" ]; then
    keytool -genkeypair -v -keystore "$HOME/.android/debug.keystore" -alias androiddebugkey \
      -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 30000 \
      -dname "CN=Android Debug,O=Android,C=US"
  fi
  (cd android && chmod +x gradlew && ./gradlew assembleDebug --no-daemon --stacktrace)
  cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT"
fi
ls -la ../dist-android
