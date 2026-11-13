FROM node:26-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY public/ /src/public/
ARG VERSION=dev
ARG VITE_FARO_APP_NAME=Manifests.io
ARG VITE_FARO_URL
ENV VITE_APP_VERSION=$VERSION
ENV VITE_FARO_APP_NAME=$VITE_FARO_APP_NAME
ENV VITE_FARO_URL=$VITE_FARO_URL
RUN npm run build && node scripts/server-build-identity.mjs \
    && mkdir /src/source-maps /src/private-artifacts \
    && cp dist/assets/*.js dist/assets/*.js.map /src/private-artifacts/ \
    && mv dist/assets/*.js.map /src/source-maps/

FROM scratch AS source-maps
COPY --from=web /src/source-maps/ /

FROM scratch AS private-artifacts
COPY --from=web /src/private-artifacts/ /assets/

FROM golang:1.27-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o build/manifests ./cmd/manifests

FROM web AS render
COPY --from=backend /src/build/manifests /src/build/manifests
COPY oaspec/kubernetes/ /src/oaspec/kubernetes/
COPY ETL/crds/ /src/ETL/crds/
RUN node scripts/prerender.mjs

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=backend /src/build/manifests /app/manifests
COPY --from=render /src/frontend/dist/ /app/frontend/dist/
COPY --from=render /src/frontend/dist-render/ /app/frontend/dist-render/
COPY --from=render /src/frontend/prerender/ /app/frontend/prerender/
COPY --from=render /src/oaspec/ /app/oaspec/
COPY --from=render /src/ETL/ /app/ETL/
COPY public/ /app/public/
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/manifests"]
