# ============================================
# Stage 1 — Build the Angular app
# ============================================
FROM node:18-alpine AS build

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci

# Copy source & build for production
COPY . .
RUN npm run build

# ============================================
# Stage 2 — Serve with Nginx
# ============================================
FROM nginx:1.27-alpine

# Remove default site
RUN rm -rf /usr/share/nginx/html/*

# Custom Nginx config (SPA routing + cache rules)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built Angular output
# Angular 17 "application" builder outputs to browser/
COPY --from=build /app/dist/displify-demo-v1/browser /usr/share/nginx/html

# Volume for JSON data files — survives container restarts
VOLUME /usr/share/nginx/html/assets

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
