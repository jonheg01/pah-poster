#!/bin/bash
set -e
mkdir -p /data/profiles /data/shots
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &
# VNC on localhost only; the browser reaches it through noVNC (websockify) behind the app's basic auth.
x11vnc -display :99 -forever -shared -localhost -rfbport 5900 -nopw -quiet >/dev/null 2>&1 &
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
exec node /app/server.js
