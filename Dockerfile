# Multi-stage Docker build for CloudVPS
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Run TypeScript type checking
RUN npm run build

# Run linting
RUN npm run lint

# Production stage
FROM node:22-alpine AS production

# Install dumb-init for proper signal handling, plus python3/pip and CLI tools
# so the automatic Discord package installer (pip: discord.py & friends,
# npm: discord.js & dotenv) and the GitHub clone feature work inside VPS
# workspaces.
RUN apk add --no-cache dumb-init python3 py3-pip git curl unzip && \
    pip3 install --no-cache-dir --break-system-packages --upgrade pip && \
    # The server runs as the non-root "nodejs" user, but the automatic
    # package installer must be able to pip-install into the system
    # site-packages (this image is a sandboxed VPS host by design).
    chmod -R a+w "$(python3 -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')" /usr/bin && \
    sh -c 'chmod -R a+w /usr/local/lib/python3.* 2>/dev/null || true'

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage (server + dashboard + API docs)
COPY --from=builder /app/server.js ./
COPY --from=builder /app/schemas.js ./
COPY --from=builder /app/errors.js ./
COPY --from=builder /app/database.js ./
COPY --from=builder /app/index.html ./
COPY --from=builder /app/openapi.yaml ./

# Create directories for data and instances
RUN mkdir -p /app/data /app/vps_instances && \
    chown -R nodejs:nodejs /app/data /app/vps_instances

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (res) => { if (res.statusCode !== 200) process.exit(1) })"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]