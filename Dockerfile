FROM node:20-alpine

# Install Lua (Alpine package name)
RUN apk add --no-cache lua5.3

WORKDIR /app
COPY . .

# Install only production dependencies (uses package‑lock)
RUN npm ci --only=production

ENV PORT=3000
EXPOSE \

CMD [\"node\",\"bot.js\"]
