#!/bin/bash
set -e

# Start virtual framebuffer
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Start window manager
fluxbox &
sleep 1

# Start VNC server
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &

# Start noVNC web client
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

echo "noVNC available at http://localhost:6080"

# Start the bot
exec node dist/index.js
