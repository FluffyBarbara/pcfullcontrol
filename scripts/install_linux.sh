#!/usr/bin/env bash
# Установка PC Full Control на Linux как пользовательской службы systemd (автозапуск при входе).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "1/4 Виртуальное окружение…"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

echo "2/4 Настройки…"
[ -f config.yaml ] || cp config.example.yaml config.yaml
if grep -q 'token: ""' config.yaml; then
  read -rp "Токен Telegram-бота от @BotFather (Enter — пропустить): " TOKEN
  if [ -n "${TOKEN:-}" ]; then
    sed -i "s|token: \"\"|token: \"${TOKEN}\"|" config.yaml
  fi
fi

echo "3/4 Служба systemd (пользовательская)…"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/pcontrol.service" <<EOF
[Unit]
Description=PC Full Control agent
After=graphical-session.target network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$ROOT/.venv/bin/python $ROOT/run.py
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pcontrol.service
# Чтобы агент работал и без входа в графический сеанс:
loginctl enable-linger "$USER" 2>/dev/null || true

echo "4/4 Готово!"
sleep 4
grep -E "Пароль веб-панели|/pair|Веб-панель:" "$ROOT/data/pcontrol.log" | tail -n 3 || true
cat <<'EOF'

Управление службой:
  systemctl --user status pcontrol     # состояние
  journalctl --user -u pcontrol -f      # лог
  systemctl --user restart pcontrol     # перезапуск

Для обновления пакетов (apt/dnf/pacman) без пароля добавьте через `sudo visudo`, например:
  ваше_имя ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf, /usr/bin/pacman, /usr/bin/snap
EOF
