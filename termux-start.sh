#!/data/data/com.termux/files/usr/bin/bash
# Android'de Termux ile YKMaps'i telefonda çalıştırır.
# İlk kurulum:  pkg install -y nodejs git && git clone <repo> ykmaps && cd ykmaps
# Çalıştırma:   bash termux-start.sh   → tarayıcıda http://localhost:8080
cd "$(dirname "$0")"
git pull --ff-only 2>/dev/null || true
termux-wake-lock 2>/dev/null || true
exec node server.js
