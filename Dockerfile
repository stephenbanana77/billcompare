FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001 5176 8791

CMD ["node", "scripts/dev-windows-lan.js"]
