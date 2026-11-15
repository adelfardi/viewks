# viewks — binaire unique (API Go + front React embarqué)
#   make install   → compile et installe ~/.local/bin/viewks, puis lance : viewks
# Go absent ? la compilation passe automatiquement par un conteneur golang.

BIN      ?= bin/viewks
PREFIX   ?= $(HOME)/.local/bin
GO_IMAGE ?= golang:1.26-alpine
GOOS     ?= $(shell uname -s | tr A-Z a-z)
GOARCH   ?= $(shell uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
HAVE_GO  := $(shell command -v go 2>/dev/null)

.PHONY: all web build install uninstall run clean docker-up dist

all: build

web: ## compile le front et le copie dans backend/web (embarqué par go:embed)
	cd frontend && npm ci --no-audit --no-fund && npm run build
	find backend/web -mindepth 1 ! -name .gitkeep -delete
	cp -r frontend/dist/. backend/web/

build: web ## binaire statique dans bin/
	@mkdir -p $(dir $(BIN))
ifdef HAVE_GO
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o ../$(BIN) .
else
	@echo "→ go introuvable, compilation dans $(GO_IMAGE)"
	docker run --rm -v "$(CURDIR)":/src -v viewks-gocache:/go -w /src/backend \
	  -e CGO_ENABLED=0 -e GOOS=$(GOOS) -e GOARCH=$(GOARCH) \
	  $(GO_IMAGE) go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o ../$(BIN) .
endif
	@ls -lh $(BIN)

VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

dist: web ## archives toutes plateformes + SHA256SUMS dans dist/ (même script que la CI)
ifdef HAVE_GO
	scripts/dist.sh $(VERSION)
else
	docker run --rm -v "$(CURDIR)":/src -v viewks-gocache:/go -w /src $(GO_IMAGE) \
	  sh -c 'apk add --no-cache zip >/dev/null && scripts/dist.sh $(VERSION)'
endif

install: build ## installe dans $(PREFIX)
	@mkdir -p $(PREFIX)
	cp $(BIN) $(PREFIX)/.viewks.tmp && chmod 755 $(PREFIX)/.viewks.tmp && mv -f $(PREFIX)/.viewks.tmp $(PREFIX)/viewks
	@echo "✓ installé : $(PREFIX)/viewks — lance : viewks"

uninstall:
	rm -f $(PREFIX)/viewks

run: build
	./$(BIN)

docker-up: ## variante docker compose
	HOME=$(HOME) docker compose up -d --build

clean:
	rm -rf bin dist frontend/dist
	find backend/web -mindepth 1 ! -name .gitkeep -delete
