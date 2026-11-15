package main

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// The React build is copied into backend/web by `make web` and embedded in the
// binary, so `viewks` runs alone (no nginx, no Docker). In the Docker image the
// directory only holds .gitkeep and nginx serves the front instead.
//
//go:embed all:web
var webFS embed.FS

// staticHandler serves the SPA, falling back to index.html for client routes.
// Returns nil when no front-end was embedded.
func staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" || p == "." {
			p = "index.html"
		}
		if _, err := fs.Stat(sub, p); err != nil {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
			p = "index.html"
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
