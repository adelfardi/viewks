FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/viewks .

FROM alpine:3.22
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates tzdata \
 && mkdir -p /data && chown 65532:65532 /data
COPY --from=build /out/viewks /usr/local/bin/viewks
# non-root by default; docker-compose.yml switches to root for rootless Docker (see comment there)
USER 65532:65532
ENV LISTEN_ADDR=:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/viewks", "-open=false", "-v"]
