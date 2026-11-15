package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Reachability is a cheap TCP probe of each context's API server, so the UI can
// flag clusters that are not reachable (VPN, private endpoint) before using them.
type Reachability struct {
	Reachable bool   `json:"reachable"`
	Error     string `json:"error,omitempty"`
	Millis    int64  `json:"ms"`
}

type reachCache struct {
	mu  sync.Mutex
	at  time.Time
	res map[string]Reachability
}

var reach reachCache

func probe(ctx context.Context, server string) Reachability {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return Reachability{Error: "URL du serveur invalide"}
	}
	host := u.Host
	if u.Port() == "" {
		port := "443"
		if u.Scheme == "http" {
			port = "80"
		}
		host = net.JoinHostPort(u.Hostname(), port)
	}
	start := time.Now()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", host)
	r := Reachability{Millis: time.Since(start).Milliseconds()}
	if err != nil {
		r.Error = err.Error()
		var ne net.Error
		if ctx.Err() != nil || (errors.As(err, &ne) && ne.Timeout()) {
			r.Error = "délai dépassé (VPN / route ?)"
		}
		return r
	}
	_ = conn.Close()
	r.Reachable = true
	return r
}

func (a *App) handleReachability(w http.ResponseWriter, r *http.Request) {
	reach.mu.Lock()
	if reach.res != nil && time.Since(reach.at) < 20*time.Second && r.URL.Query().Get("refresh") != "1" {
		res := reach.res
		reach.mu.Unlock()
		writeJSON(w, 200, res)
		return
	}
	reach.mu.Unlock()

	ctxs, _, _ := a.kube.Contexts()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	out := make(map[string]Reachability, len(ctxs))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range ctxs {
		wg.Add(1)
		go func(name, server string) {
			defer wg.Done()
			res := probe(ctx, server)
			mu.Lock()
			out[name] = res
			mu.Unlock()
		}(c.Name, c.Server)
	}
	wg.Wait()

	reach.mu.Lock()
	reach.res, reach.at = out, time.Now()
	reach.mu.Unlock()
	writeJSON(w, 200, out)
}
