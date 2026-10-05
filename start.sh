#!/bin/bash
set -e
mkdir -p /data/profiles /data/shots
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &
# VNC on localhost only; the browser reaches it through noVNC (websockify) behind the app's basic auth.
x11vnc -display :99 -forever -shared -localhost -rfbport 5900 -nopw -quiet >/dev/null 2>&1 &
# Locate the noVNC web root (package layouts differ); make sure vnc.html exists at its top level.
WEB=/app/novnc
rm -rf "$WEB"; mkdir -p "$WEB"
SRC=$(dirname "$(find /usr/share/novnc /usr/share/javascript/novnc /usr/share/noVNC -name 'vnc.html' -o -name 'vnc_lite.html' 2>/dev/null | head -1)")
cp -r "$SRC"/. "$WEB"/ 2>/dev/null || true
[ -f "$WEB/vnc.html" ] || { [ -f "$WEB/vnc_lite.html" ] && cp "$WEB/vnc_lite.html" "$WEB/vnc.html"; }
[ -f "$WEB/index.html" ] || cp "$WEB/vnc.html" "$WEB/index.html" 2>/dev/null || true
echo "noVNC root: $SRC -> $WEB ($(ls "$WEB" | head -20 | tr '\n' ' '))"
websockify --web "$WEB" 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
exec node /app/server.js
