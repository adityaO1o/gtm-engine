# Static Go binary on a scratch-ish base. The crawler talks to Mongo and the open internet and
# nothing else, so it needs no shell, no package manager, and no OS to keep patched — only CA roots
# for TLS.
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod ./
RUN go mod download || true
COPY . .
# Resolve the dependency graph from the actual sources, then build. `go mod tidy` here means the
# module file does not have to carry an exact, hand-maintained require list.
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /crawler .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 crawler
USER crawler
COPY --from=build /crawler /crawler
ENTRYPOINT ["/crawler"]
