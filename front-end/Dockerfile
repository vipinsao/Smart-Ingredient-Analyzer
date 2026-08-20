# ---- build ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Vite inlines VITE_* variables into the bundle at build time, so the API
# address has to be known here, not at container start.
ARG VITE_API_URL=http://localhost:5000
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- serve ----
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
