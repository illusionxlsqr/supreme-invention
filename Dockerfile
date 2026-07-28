FROM node:20-bullseye-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY bot.js ./
CMD ["node", "bot.js"]
