# Stage 1: Build native modules
FROM node:24-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (bcrypt, sqlite3)
RUN apk add --no-cache python3 make g++

# Install app dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Runtime image (no build tools)
FROM node:24-alpine

WORKDIR /app

# Copy installed node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Bundle app source
COPY package*.json ./
COPY . .

# Define build arguments for provenance. VERSION is also handed to the running
# server as APP_VERSION; the three of them become OCI labels so that the image
# itself says which release it is, which is what links the package to this repo
# on GHCR and what `docker inspect` reports.
ARG VERSION=development
ARG REVISION=unknown
ARG CREATED=unknown
ENV APP_VERSION=$VERSION

LABEL org.opencontainers.image.title="FHIRsmith" \
      org.opencontainers.image.description="A Node.js server that provides a collection of tools to serve the FHIR ecosystem" \
      org.opencontainers.image.vendor="Health Intersections Pty Ltd" \
      org.opencontainers.image.licenses="BSD-3-Clause" \
      org.opencontainers.image.url="https://github.com/HealthIntersections/fhirsmith" \
      org.opencontainers.image.source="https://github.com/HealthIntersections/fhirsmith" \
      org.opencontainers.image.documentation="https://github.com/HealthIntersections/fhirsmith#readme" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# Expose port and define command
EXPOSE 3000
CMD ["node", "server.js"]