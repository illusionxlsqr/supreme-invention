FROM node:20-bullseye-slim

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev --legacy-peer-deps

COPY bot.js ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "bot.js"]
