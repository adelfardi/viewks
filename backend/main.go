package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Settings are the user-level choices of the UI, persisted on disk.
type Settings struct {
	ActiveProfile string `json:"activeProfile"`
	// ForceProfile: use ActiveProfile for every EKS cluster instead of the
	// AWS_PROFILE declared in the kubeconfig exec section.
	ForceProfile bool `json:"forceProfile"`
	// ReadOnly blocks every mutating call (delete, edit, scale, exec...).
	ReadOnly bool `json:"readOnly"`
}

type App struct {
	aws  *AWSManager
	kube *KubeManager

	mu           sync.RWMutex
	settings     Settings
	settingsPath string
}

func (a *App) Settings() Settings {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.settings
}

func (a *App) SetSettings(s Settings) error {
	a.mu.Lock()
	a.settings = s
	a.mu.Unlock()
	a.kube.InvalidateClients()
	if a.settingsPath == "" {
		return nil
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	if err := os.MkdirAll(filepath.Dir(a.settingsPath), 0o700); err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath, b, 0o600)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var verbose bool

// version is injected at build time: -ldflags "-X main.version=v1.2.3"
var version = "dev"

func main() {
	addr := flag.String("addr", env("LISTEN_ADDR", "127.0.0.1:8088"), "adresse d'écoute (garder 127.0.0.1 : l'outil agit avec tes droits AWS/kube)")
	openBrowser := flag.Bool("open", true, "ouvrir le navigateur au démarrage")
	flag.BoolVar(&verbose, "v", false, "logger chaque requête HTTP")
	showVersion := flag.Bool("version", false, "afficher la version")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "viewks — console EKS locale\n\nUsage : viewks [options]\n\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nVariables : AWS_DIR (~/.aws), KUBE_DIR (~/.kube), DATA_DIR (~/.viewks)\n")
	}
	flag.Parse()
	if *showVersion {
		fmt.Printf("viewks %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	}

	home, _ := os.UserHomeDir()
	awsDir := env("AWS_DIR", filepath.Join(home, ".aws"))
	kubeDir := env("KUBE_DIR", filepath.Join(home, ".kube"))
	dataDir := env("DATA_DIR", filepath.Join(home, ".viewks"))

	app := &App{settingsPath: filepath.Join(dataDir, "settings.json")}
	if b, err := os.ReadFile(app.settingsPath); err == nil {
		_ = json.Unmarshal(b, &app.settings)
	}
	app.aws = NewAWSManager(awsDir)
	app.kube = NewKubeManager(kubeDir, app)

	if app.settings.ActiveProfile == "" {
		// default: profile of the current kube context, else first SSO profile
		ctxs, cur, _ := app.kube.Contexts()
		for _, c := range ctxs {
			if c.Name == cur && c.AWSProfile != "" {
				app.settings.ActiveProfile = c.AWSProfile
			}
		}
		if ps, err := app.aws.Profiles(); err == nil && app.settings.ActiveProfile == "" {
			for _, p := range ps {
				if p.Type == "sso" {
					app.settings.ActiveProfile = p.Name
					break
				}
			}
			if app.settings.ActiveProfile == "" && len(ps) > 0 {
				app.settings.ActiveProfile = ps[0].Name
			}
		}
	}

	mux := http.NewServeMux()
	app.routes(mux)
	if h := staticHandler(); h != nil {
		mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "route inconnue"})
		})
		mux.Handle("/", h)
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("impossible d'écouter sur %s : %v (déjà lancé ? autre port : -addr 127.0.0.1:9000)", *addr, err)
	}
	srv := &http.Server{Handler: withLogging(mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	url := "http://" + browserHost(ln.Addr().String())
	if staticHandler() != nil {
		log.Printf("viewks %s prêt → %s   (Ctrl+C pour arrêter)", version, url)
		if *openBrowser {
			go openURL(url)
		}
	} else {
		log.Printf("viewks API sur %s (front servi séparément)", ln.Addr())
	}
	log.Printf("aws=%s kube=%s data=%s", awsDir, kubeDir, dataDir)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController / websocket hijacking reach the real writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// websocket upgrades need the raw writer (Hijacker)
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			next.ServeHTTP(w, r)
			if verbose {
				log.Printf("%s %s [ws] %s", r.Method, r.URL.Path, time.Since(start))
			}
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if verbose && r.URL.Path != "/api/health" {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}

// browserHost turns a listen address into something a browser can open.
func browserHost(a string) string {
	host, port, err := net.SplitHostPort(a)
	if err != nil {
		return a
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "localhost"
	}
	return net.JoinHostPort(host, port)
}

func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Stdout, cmd.Stderr = nil, nil
	_ = cmd.Start()
}
