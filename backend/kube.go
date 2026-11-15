package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

type ContextInfo struct {
	Name       string `json:"name"`
	Cluster    string `json:"cluster"`
	User       string `json:"user"`
	Namespace  string `json:"namespace,omitempty"`
	Server     string `json:"server,omitempty"`
	File       string `json:"file"`
	IsEKS      bool   `json:"isEks"`
	EKSCluster string `json:"eksCluster,omitempty"`
	Region     string `json:"region,omitempty"`
	RoleArn    string `json:"roleArn,omitempty"`
	AWSProfile string `json:"awsProfile,omitempty"` // declared in kubeconfig
	Effective  string `json:"effectiveProfile,omitempty"`
	Prod       bool   `json:"prod"`
}

type kclient struct {
	cfg    *rest.Config
	cs     *kubernetes.Clientset
	dyn    dynamic.Interface
	disc   discovery.CachedDiscoveryInterface
	mapper *restmapper.DeferredDiscoveryRESTMapper
}

type KubeManager struct {
	dir string
	app *App

	mu       sync.Mutex
	sig      string
	raw      *clientcmdapi.Config
	contexts []ContextInfo
	current  string
	loadErrs []string
	clients  map[string]*kclient
}

func NewKubeManager(dir string, app *App) *KubeManager {
	return &KubeManager{dir: dir, app: app, clients: map[string]*kclient{}}
}

var skipSuffix = regexp.MustCompile(`(?i)(\.old|\.bak|\.orig|\.backup|\.tmp|\.lock|~)$`)
var prodRe = regexp.MustCompile(`(?i)(^|[-_./:])(prd|prod|production)([-_./:]|$)`)

func (k *KubeManager) files() []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			seen[p] = true
			out = append(out, p)
		}
	}
	if entries, err := os.ReadDir(k.dir); err == nil {
		names := []string{}
		for _, e := range entries {
			n := e.Name()
			if e.IsDir() || !strings.HasPrefix(n, "config") || skipSuffix.MatchString(n) {
				continue
			}
			names = append(names, n)
		}
		sort.Strings(names)
		// plain "config" first so it wins on duplicates
		for _, n := range names {
			if n == "config" {
				add(filepath.Join(k.dir, n))
			}
		}
		for _, n := range names {
			add(filepath.Join(k.dir, n))
		}
	}
	for _, p := range filepath.SplitList(os.Getenv("KUBECONFIG")) {
		add(p)
	}
	return out
}

func signature(files []string) string {
	var b strings.Builder
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			fmt.Fprintf(&b, "%s:%d:%d;", f, st.ModTime().UnixNano(), st.Size())
		}
	}
	return b.String()
}

// reload merges every kubeconfig file in ~/.kube when one of them changed.
func (k *KubeManager) reload() {
	files := k.files()
	sig := signature(files)
	k.mu.Lock()
	defer k.mu.Unlock()
	if sig == k.sig && k.raw != nil {
		return
	}

	merged := clientcmdapi.NewConfig()
	var infos []ContextInfo
	var errs []string
	current := ""
	for _, f := range files {
		c, err := clientcmd.LoadFromFile(f)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", filepath.Base(f), err))
			continue
		}
		if err := clientcmd.ResolveLocalPaths(c); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", filepath.Base(f), err))
		}
		if current == "" && c.CurrentContext != "" {
			if _, ok := c.Contexts[c.CurrentContext]; ok {
				current = c.CurrentContext
			}
		}
		names := make([]string, 0, len(c.Contexts))
		for n := range c.Contexts {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if _, dup := merged.Contexts[n]; dup {
				continue
			}
			ctx := c.Contexts[n]
			cl, okc := c.Clusters[ctx.Cluster]
			ai, oka := c.AuthInfos[ctx.AuthInfo]
			if !okc || !oka {
				errs = append(errs, fmt.Sprintf("%s: contexte %q incomplet", filepath.Base(f), n))
				continue
			}
			// namespace cluster/user names per file to avoid cross-file collisions
			clName := ctx.Cluster + "@" + filepath.Base(f)
			aiName := ctx.AuthInfo + "@" + filepath.Base(f)
			merged.Clusters[clName] = cl
			merged.AuthInfos[aiName] = ai
			nc := ctx.DeepCopy()
			nc.Cluster, nc.AuthInfo = clName, aiName
			merged.Contexts[n] = nc

			info := ContextInfo{
				Name: n, Cluster: ctx.Cluster, User: ctx.AuthInfo, Namespace: ctx.Namespace,
				Server: cl.Server, File: filepath.Base(f),
			}
			parseExec(ai, &info)
			info.Prod = prodRe.MatchString(n) || prodRe.MatchString(info.EKSCluster) || prodRe.MatchString(info.AWSProfile)
			infos = append(infos, info)
		}
	}
	// kubectx stores the last used context
	if b, err := os.ReadFile(filepath.Join(k.dir, "kubectx")); err == nil {
		if n := strings.TrimSpace(string(b)); n != "" {
			if _, ok := merged.Contexts[n]; ok {
				current = n
			}
		}
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name < infos[j].Name })
	k.raw, k.contexts, k.loadErrs, k.current, k.sig = merged, infos, errs, current, sig
	k.clients = map[string]*kclient{}
}

func flagVal(args []string, names ...string) string {
	for i, a := range args {
		for _, n := range names {
			if a == n && i+1 < len(args) {
				return args[i+1]
			}
			if strings.HasPrefix(a, n+"=") {
				return strings.TrimPrefix(a, n+"=")
			}
		}
	}
	return ""
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func parseExec(ai *clientcmdapi.AuthInfo, info *ContextInfo) {
	if ai == nil || ai.Exec == nil {
		return
	}
	cmd := filepath.Base(ai.Exec.Command)
	args := ai.Exec.Args
	envs := map[string]string{}
	for _, e := range ai.Exec.Env {
		envs[e.Name] = e.Value
	}
	switch {
	case cmd == "aws" && contains(args, "eks") && contains(args, "get-token"):
		info.IsEKS = true
		info.EKSCluster = flagVal(args, "--cluster-name")
		if id := flagVal(args, "--cluster-id"); info.EKSCluster == "" {
			info.EKSCluster = id
		}
		info.Region = flagVal(args, "--region")
		info.RoleArn = flagVal(args, "--role-arn")
		info.AWSProfile = flagVal(args, "--profile")
	case cmd == "aws-iam-authenticator":
		info.IsEKS = true
		info.EKSCluster = flagVal(args, "-i", "--cluster-id")
		info.RoleArn = flagVal(args, "-r", "--role")
		info.Region = flagVal(args, "--region")
	default:
		return
	}
	if info.AWSProfile == "" {
		info.AWSProfile = envs["AWS_PROFILE"]
	}
	if info.Region == "" {
		info.Region = firstNonEmpty(envs["AWS_REGION"], envs["AWS_DEFAULT_REGION"])
	}
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

func (k *KubeManager) effectiveProfile(info ContextInfo) string {
	s := k.app.Settings()
	if s.ForceProfile && s.ActiveProfile != "" {
		return s.ActiveProfile
	}
	return firstNonEmpty(info.AWSProfile, s.ActiveProfile)
}

func (k *KubeManager) Contexts() ([]ContextInfo, string, []string) {
	k.reload()
	k.mu.Lock()
	defer k.mu.Unlock()
	out := make([]ContextInfo, len(k.contexts))
	copy(out, k.contexts)
	for i := range out {
		if out[i].IsEKS {
			out[i].Effective = k.effectiveProfile(out[i])
		}
	}
	return out, k.current, k.loadErrs
}

func (k *KubeManager) InvalidateClients() {
	k.mu.Lock()
	k.clients = map[string]*kclient{}
	k.mu.Unlock()
}

func (k *KubeManager) Info(name string) (ContextInfo, bool) {
	k.reload()
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, c := range k.contexts {
		if c.Name == name {
			return c, true
		}
	}
	return ContextInfo{}, false
}

type eksTransport struct {
	next  http.RoundTripper
	token func(ctx context.Context) (string, error)
}

func (t *eksTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	tok, err := t.token(req.Context())
	if err != nil {
		return nil, err
	}
	r := req.Clone(req.Context())
	r.Header.Set("Authorization", "Bearer "+tok)
	return t.next.RoundTrip(r)
}

func (k *KubeManager) Client(name string) (*kclient, error) {
	info, ok := k.Info(name)
	if !ok {
		return nil, fmt.Errorf("contexte %q introuvable", name)
	}
	profile := ""
	if info.IsEKS {
		profile = k.effectiveProfile(info)
	}
	key := name + "|" + profile

	k.mu.Lock()
	if c, ok := k.clients[key]; ok {
		k.mu.Unlock()
		return c, nil
	}
	raw := k.raw
	k.mu.Unlock()

	cfg, err := clientcmd.NewNonInteractiveClientConfig(*raw, name, &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		return nil, err
	}
	if info.IsEKS && info.EKSCluster != "" {
		cfg.ExecProvider = nil
		cfg.AuthProvider = nil
		region := info.Region
		aws := k.app.aws
		cfg.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
			return &eksTransport{next: rt, token: func(ctx context.Context) (string, error) {
				return aws.EKSToken(ctx, profile, region, info.EKSCluster, info.RoleArn)
			}}
		}
	}
	// fail fast on unreachable (private) endpoints instead of the 30s default
	cfg.Dial = (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	cfg.QPS, cfg.Burst = 50, 100
	cfg.UserAgent = "viewks"

	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	disc := memory.NewMemCacheClient(cs.Discovery())
	c := &kclient{cfg: cfg, cs: cs, dyn: dyn, disc: disc, mapper: restmapper.NewDeferredDiscoveryRESTMapper(disc)}
	k.mu.Lock()
	k.clients[key] = c
	k.mu.Unlock()
	return c, nil
}

// ---------------------------------------------------------------- resources

type resolved struct {
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
}

func (c *kclient) resolve(res string) (resolved, error) {
	var r resolved
	in := schema.GroupVersionResource{Resource: strings.ToLower(res)}
	if i := strings.Index(res, "."); i > 0 {
		in = schema.GroupVersionResource{Resource: strings.ToLower(res[:i]), Group: res[i+1:]}
	}
	try := func() error {
		gvr, err := c.mapper.ResourceFor(in)
		if err != nil {
			return err
		}
		gvk, err := c.mapper.KindFor(gvr)
		if err != nil {
			return err
		}
		mapping, err := c.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
		if err != nil {
			return err
		}
		r = resolved{GVR: gvr, Kind: gvk.Kind, Namespaced: mapping.Scope.Name() == meta.RESTScopeNameNamespace}
		return nil
	}
	if err := try(); err != nil {
		c.mapper.Reset()
		if err2 := try(); err2 != nil {
			return r, err2
		}
	}
	return r, nil
}

func apiPath(gvr schema.GroupVersionResource, namespaced bool, ns string) string {
	p := "/api/" + gvr.Version
	if gvr.Group != "" {
		p = "/apis/" + gvr.Group + "/" + gvr.Version
	}
	if namespaced && ns != "" {
		p += "/namespaces/" + ns
	}
	return p + "/" + gvr.Resource
}

type TableColumn struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Format      string `json:"format,omitempty"`
	Priority    int32  `json:"priority"`
	Description string `json:"description,omitempty"`
}

type TableRow struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Created   string            `json:"created,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	Cells     []any             `json:"cells"`
}

type TableResp struct {
	Kind       string        `json:"kind"`
	Resource   string        `json:"resource"`
	Group      string        `json:"group"`
	Namespaced bool          `json:"namespaced"`
	Columns    []TableColumn `json:"columns"`
	Rows       []TableRow    `json:"rows"`
}

const tableAccept = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json;as=Table;v=v1beta1;g=meta.k8s.io,application/json"

// Table uses server-side printing: same columns as `kubectl get`.
func (c *kclient) Table(ctx context.Context, r resolved, ns, labelSelector string) (*TableResp, error) {
	req := c.cs.Discovery().RESTClient().Get().
		AbsPath(apiPath(r.GVR, r.Namespaced, ns)).
		Param("includeObject", "Metadata").
		SetHeader("Accept", tableAccept)
	if labelSelector != "" {
		req = req.Param("labelSelector", labelSelector)
	}
	raw, err := req.Do(ctx).Raw()
	if err != nil {
		return nil, err
	}
	var t metav1.Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	out := &TableResp{Kind: r.Kind, Resource: r.GVR.Resource, Group: r.GVR.Group, Namespaced: r.Namespaced}
	for _, col := range t.ColumnDefinitions {
		out.Columns = append(out.Columns, TableColumn{Name: col.Name, Type: col.Type, Format: col.Format, Priority: col.Priority, Description: col.Description})
	}
	out.Rows = make([]TableRow, 0, len(t.Rows))
	for _, row := range t.Rows {
		tr := TableRow{Cells: row.Cells}
		if len(row.Object.Raw) > 0 {
			var pm metav1.PartialObjectMetadata
			if json.Unmarshal(row.Object.Raw, &pm) == nil {
				tr.Name, tr.Namespace, tr.Labels = pm.Name, pm.Namespace, pm.Labels
				if !pm.CreationTimestamp.IsZero() {
					tr.Created = pm.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z")
				}
			}
		}
		if tr.Name == "" && len(row.Cells) > 0 {
			tr.Name = fmt.Sprint(row.Cells[0])
		}
		out.Rows = append(out.Rows, tr)
	}
	return out, nil
}
