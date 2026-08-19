FROM node:20-bookworm-slim

# better-sqlite3 (native modul) icin prebuild-install basarisiz olursa
# node-gyp ile kaynaktan derleyebilmek adina gerekli araclar.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci && npm run build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "run", "start"]
