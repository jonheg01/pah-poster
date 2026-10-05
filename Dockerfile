FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Headful Chromium on a virtual display, shared over VNC so Jon can log in to each platform once.
ENV DEBIAN_FRONTEND=noninteractive TZ=America/Phoenix
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox \
  && rm -rf /var/lib/apt/lists/* \
  && echo "noVNC files:" && (find / -name 'vnc.html' -o -name 'vnc_lite.html' 2>/dev/null | grep -v proc | head -5)

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN chmod +x /app/start.sh

ENV DISPLAY=:99
ENV PROFILE_ROOT=/data/profiles
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000
CMD ["/app/start.sh"]
