FROM node:22-bookworm-slim

# sharp and tesseract.js both ship prebuilt binaries for this base image, so no
# compiler toolchain is needed.
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# eng.traineddata is committed, so Tesseract does not download a language pack
# on the first request inside the container.
ENV NODE_ENV=production
ENV PORT=5000

USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
