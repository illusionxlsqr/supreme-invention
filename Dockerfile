FROM node:20-alpine

# Install Lua (Alpine package)
RUN apk add --no-cache lua5.3

WORKDIR /app
COPY . .

# Install production deps (uses package-lock.json)
RUN npm ci --only=production

ENV PORT=3000
EXPOSE \

CMD [\"node\",\"bot.js\"]
