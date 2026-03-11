FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Install noVNC for visual debugging
RUN apt-get update && apt-get install -y \
    novnc \
    x11vnc \
    xvfb \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Create directories for screenshots and data
RUN mkdir -p /tmp/screenshots /app/data

ENV NODE_ENV=production
ENV DISPLAY=:99

# Start script that launches Xvfb + VNC + app
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 6080

ENTRYPOINT ["/docker-entrypoint.sh"]
