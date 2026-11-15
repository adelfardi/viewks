package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	"sigs.k8s.io/yaml"
)

func (a *App) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "version": version})
	})

	// AWS
	mux.HandleFunc("GET /api/aws/profiles", a.handleProfiles)
	mux.HandleFunc("GET /api/aws/status", a.handleAWSStatus)
	mux.HandleFunc("POST /api/aws/login", a.handleLoginStart)
	mux.HandleFunc("GET /api/aws/login/{id}", a.handleLoginPoll)
	mux.HandleFunc("POST /api/aws/logout", a.handleLogout)

	// settings
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.Settings()) })
	mux.HandleFunc("PUT /api/settings", a.handlePutSettings)

	// kube
	mux.HandleFunc("GET /api/contexts", a.handleContexts)
	mux.HandleFunc("GET /api/contexts/reachability", a.handleReachability)
	mux.HandleFunc("GET /api/ctx/{ctx}/overview", a.handleOverview)
	mux.HandleFunc("GET /api/ctx/{ctx}/namespaces", a.handleNamespaces)
	mux.HandleFunc("GET /api/ctx/{ctx}/api-resources", a.handleAPIResources)
	mux.HandleFunc("GET /api/ctx/{ctx}/metrics/{kind}", a.handleMetrics)
	mux.HandleFunc("GET /api/ctx/{ctx}/events", a.handleEvents)
	mux.HandleFunc("GET /api/ctx/{ctx}/r/{res}", a.handleList)
	mux.HandleFunc("GET /api/ctx/{ctx}/r/{res}/{name}", a.handleGet)
	mux.HandleFunc("PUT /api/ctx/{ctx}/r/{res}/{name}", a.mut(a.handleUpdate))
	mux.HandleFunc("PATCH /api/ctx/{ctx}/r/{res}/{name}", a.mut(a.handlePatch))
	mux.HandleFunc("DELETE /api/ctx/{ctx}/r/{res}/{name}", a.mut(a.handleDelete))
	mux.HandleFunc("POST /api/ctx/{ctx}/cronjobs/{ns}/{name}/trigger", a.mut(a.handleTriggerCron))
	mux.HandleFunc("GET /api/ctx/{ctx}/logs/{ns}/{pod}", a.handleLogs)
	mux.HandleFunc("GET /api/ctx/{ctx}/exec/{ns}/{pod}", a.mut(a.handleExec))
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errInfo(err error) (int, string) {
	var ae *AuthError
	if errors.As(err, &ae) || strings.Contains(err.Error(), "aws-auth:") {
		return http.StatusUnauthorized, "aws_auth"
	}
	if msg := err.Error(); strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "connection refused") || strings.Contains(msg, "no route to host") {
		return http.StatusBadGateway, "unreachable"
	}
	var st apierrors.APIStatus
	if errors.As(err, &st) && st.Status().Code != 0 {
		return int(st.Status().Code), string(st.Status().Reason)
	}
	return http.StatusInternalServerError, ""
}

func writeErr(w http.ResponseWriter, err error) {
	code, reason := errInfo(err)
	msg := err.Error()
	if reason == "unreachable" {
		msg = "API server injoignable (endpoint privé : VPN / réseau ?) — " + msg
	}
	writeJSON(w, code, map[string]string{"error": msg, "reason": reason})
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

func (a *App) mut(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.Settings().ReadOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "mode lecture seule activé", "reason": "read_only"})
			return
		}
		h(w, r)
	}
}

func (a *App) client(w http.ResponseWriter, r *http.Request) (*kclient, bool) {
	c, err := a.kube.Client(r.PathValue("ctx"))
	if err != nil {
		writeErr(w, err)
		return nil, false
	}
	return c, true
}

func ns(r *http.Request) string {
	n := r.URL.Query().Get("ns")
	if n == "_all" {
		return ""
	}
	return n
}

// ---------------------------------------------------------------- AWS handlers

func (a *App) handleProfiles(w http.ResponseWriter, r *http.Request) {
	ps, err := a.aws.Profiles()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, ps)
}

func (a *App) handleAWSStatus(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("profile")
	if p == "" {
		p = a.Settings().ActiveProfile
	}
	if p == "" {
		badRequest(w, "aucun profil sélectionné")
		return
	}
	writeJSON(w, 200, a.aws.Status(r.Context(), p, r.URL.Query().Get("identity") != "0"))
}

func (a *App) handleLoginStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile string `json:"profile"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Profile == "" {
		body.Profile = a.Settings().ActiveProfile
	}
	st, err := a.aws.StartLogin(r.Context(), body.Profile)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, st)
}

func (a *App) handleLoginPoll(w http.ResponseWriter, r *http.Request) {
	st, ok := a.aws.Login(r.PathValue("id"))
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "login inconnu"})
		return
	}
	if st.Status == "success" {
		a.kube.InvalidateClients()
	}
	writeJSON(w, 200, st)
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile string `json:"profile"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Profile == "" {
		body.Profile = a.Settings().ActiveProfile
	}
	if err := a.aws.Logout(body.Profile); err != nil {
		writeErr(w, err)
		return
	}
	a.kube.InvalidateClients()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var s Settings
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		badRequest(w, err.Error())
		return
	}
	if err := a.SetSettings(s); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, s)
}

// ---------------------------------------------------------------- kube handlers

func (a *App) handleContexts(w http.ResponseWriter, r *http.Request) {
	cs, cur, errs := a.kube.Contexts()
	if errs == nil {
		errs = []string{}
	}
	writeJSON(w, 200, map[string]any{"contexts": cs, "current": cur, "errors": errs})
}

func (a *App) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	list, err := c.cs.CoreV1().Namespaces().List(r.Context(), metav1.ListOptions{})
	if err != nil {
		if apierrors.IsForbidden(err) {
			info, _ := a.kube.Info(r.PathValue("ctx"))
			items := []string{}
			if info.Namespace != "" {
				items = append(items, info.Namespace)
			}
			writeJSON(w, 200, map[string]any{"items": items, "restricted": true})
			return
		}
		writeErr(w, err)
		return
	}
	names := make([]string, 0, len(list.Items))
	for _, n := range list.Items {
		names = append(names, n.Name)
	}
	sort.Strings(names)
	writeJSON(w, 200, map[string]any{"items": names, "restricted": false})
}

type APIResource struct {
	Name       string   `json:"name"`
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	ShortNames []string `json:"shortNames,omitempty"`
}

func (a *App) handleAPIResources(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	lists, err := c.disc.ServerPreferredResources()
	if err != nil && len(lists) == 0 {
		writeErr(w, err)
		return
	}
	out := []APIResource{}
	for _, l := range lists {
		gv, _ := schema.ParseGroupVersion(l.GroupVersion)
		for _, res := range l.APIResources {
			if strings.Contains(res.Name, "/") || !contains(res.Verbs, "list") {
				continue
			}
			out = append(out, APIResource{Name: res.Name, Group: gv.Group, Version: gv.Version, Kind: res.Kind, Namespaced: res.Namespaced, ShortNames: res.ShortNames})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Name < out[j].Name
	})
	writeJSON(w, 200, out)
}

func (a *App) handleList(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	res, err := c.resolve(r.PathValue("res"))
	if err != nil {
		writeErr(w, err)
		return
	}
	t, err := c.Table(r.Context(), res, ns(r), r.URL.Query().Get("labelSelector"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, t)
}

func (a *App) dynFor(w http.ResponseWriter, r *http.Request) (*kclient, resolved, string, bool) {
	c, ok := a.client(w, r)
	if !ok {
		return nil, resolved{}, "", false
	}
	res, err := c.resolve(r.PathValue("res"))
	if err != nil {
		writeErr(w, err)
		return nil, res, "", false
	}
	n := ""
	if res.Namespaced {
		n = ns(r)
		if n == "" {
			badRequest(w, "paramètre ns requis")
			return nil, res, "", false
		}
	}
	return c, res, n, true
}

func stripObject(u *unstructured.Unstructured) {
	unstructured.RemoveNestedField(u.Object, "metadata", "managedFields")
}

func (a *App) handleGet(w http.ResponseWriter, r *http.Request) {
	c, res, n, ok := a.dynFor(w, r)
	if !ok {
		return
	}
	u, err := c.dyn.Resource(res.GVR).Namespace(n).Get(r.Context(), r.PathValue("name"), metav1.GetOptions{})
	if err != nil {
		writeErr(w, err)
		return
	}
	stripObject(u)
	y, _ := yaml.Marshal(u.Object)
	writeJSON(w, 200, map[string]any{"yaml": string(y), "object": u.Object, "kind": res.Kind})
}

func (a *App) handleUpdate(w http.ResponseWriter, r *http.Request) {
	c, res, n, ok := a.dynFor(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 5<<20))
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	js, err := yaml.YAMLToJSON(body)
	if err != nil {
		badRequest(w, "YAML invalide: "+err.Error())
		return
	}
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON(js); err != nil {
		badRequest(w, "objet invalide: "+err.Error())
		return
	}
	if u.GetName() != r.PathValue("name") {
		badRequest(w, "metadata.name ne peut pas être modifié")
		return
	}
	out, err := c.dyn.Resource(res.GVR).Namespace(n).Update(r.Context(), u, metav1.UpdateOptions{FieldManager: "viewks"})
	if err != nil {
		writeErr(w, err)
		return
	}
	stripObject(out)
	y, _ := yaml.Marshal(out.Object)
	writeJSON(w, 200, map[string]any{"yaml": string(y), "object": out.Object})
}

func (a *App) handlePatch(w http.ResponseWriter, r *http.Request) {
	c, res, n, ok := a.dynFor(w, r)
	if !ok {
		return
	}
	var body struct {
		Type  string          `json:"type"`
		Patch json.RawMessage `json:"patch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Patch) == 0 {
		badRequest(w, "body attendu: {type, patch}")
		return
	}
	pt := types.MergePatchType
	switch body.Type {
	case "json":
		pt = types.JSONPatchType
	case "strategic":
		pt = types.StrategicMergePatchType
	}
	out, err := c.dyn.Resource(res.GVR).Namespace(n).Patch(r.Context(), r.PathValue("name"), pt, body.Patch, metav1.PatchOptions{FieldManager: "viewks"})
	if err != nil {
		writeErr(w, err)
		return
	}
	stripObject(out)
	writeJSON(w, 200, map[string]any{"object": out.Object})
}

func (a *App) handleDelete(w http.ResponseWriter, r *http.Request) {
	c, res, n, ok := a.dynFor(w, r)
	if !ok {
		return
	}
	prop := metav1.DeletePropagationBackground
	opts := metav1.DeleteOptions{PropagationPolicy: &prop}
	if r.URL.Query().Get("force") == "1" {
		var zero int64
		opts.GracePeriodSeconds = &zero
	}
	if err := c.dyn.Resource(res.GVR).Namespace(n).Delete(r.Context(), r.PathValue("name"), opts); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) handleTriggerCron(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	namespace, name := r.PathValue("ns"), r.PathValue("name")
	cj, err := c.cs.BatchV1().CronJobs(namespace).Get(r.Context(), name, metav1.GetOptions{})
	if err != nil {
		writeErr(w, err)
		return
	}
	base := name
	if len(base) > 45 {
		base = base[:45]
	}
	ann := map[string]string{"cronjob.kubernetes.io/instantiate": "manual"}
	for k, v := range cj.Spec.JobTemplate.Annotations {
		ann[k] = v
	}
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:            fmt.Sprintf("%s-manual-%d", base, time.Now().Unix()),
			Namespace:       namespace,
			Labels:          cj.Spec.JobTemplate.Labels,
			Annotations:     ann,
			OwnerReferences: []metav1.OwnerReference{*metav1.NewControllerRef(cj, batchv1.SchemeGroupVersion.WithKind("CronJob"))},
		},
		Spec: cj.Spec.JobTemplate.Spec,
	}
	out, err := c.cs.BatchV1().Jobs(namespace).Create(r.Context(), job, metav1.CreateOptions{FieldManager: "viewks"})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"job": out.Name})
}

// ---------------------------------------------------------------- events

type EventItem struct {
	Type      string `json:"type"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Count     int32  `json:"count"`
	Last      string `json:"last"`
	Source    string `json:"source,omitempty"`
}

func eventTime(e *corev1.Event) time.Time {
	switch {
	case !e.LastTimestamp.IsZero():
		return e.LastTimestamp.Time
	case !e.EventTime.IsZero():
		return e.EventTime.Time
	case !e.FirstTimestamp.IsZero():
		return e.FirstTimestamp.Time
	}
	return e.CreationTimestamp.Time
}

func toEvents(items []corev1.Event, limit int) []EventItem {
	sort.Slice(items, func(i, j int) bool { return eventTime(&items[i]).After(eventTime(&items[j])) })
	out := []EventItem{}
	for i := range items {
		if limit > 0 && len(out) >= limit {
			break
		}
		e := &items[i]
		count := e.Count
		if count == 0 && e.Series != nil {
			count = e.Series.Count
		}
		if count == 0 {
			count = 1
		}
		out = append(out, EventItem{
			Type: e.Type, Reason: e.Reason, Message: e.Message,
			Kind: e.InvolvedObject.Kind, Name: e.InvolvedObject.Name, Namespace: e.Namespace,
			Count: count, Last: eventTime(e).UTC().Format(time.RFC3339),
			Source: firstNonEmpty(e.Source.Component, e.ReportingController),
		})
	}
	return out
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	sel := fields.Set{}
	if v := q.Get("name"); v != "" {
		sel["involvedObject.name"] = v
	}
	if v := q.Get("kind"); v != "" {
		sel["involvedObject.kind"] = v
	}
	if v := q.Get("type"); v != "" {
		sel["type"] = v
	}
	list, err := c.cs.CoreV1().Events(ns(r)).List(r.Context(), metav1.ListOptions{FieldSelector: sel.AsSelector().String()})
	if err != nil {
		writeErr(w, err)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	writeJSON(w, 200, toEvents(list.Items, limit))
}

// ---------------------------------------------------------------- metrics

type metricsList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Usage      map[string]resource.Quantity `json:"usage"`
		Containers []struct {
			Usage map[string]resource.Quantity `json:"usage"`
		} `json:"containers"`
	} `json:"items"`
}

type Usage struct {
	CPUm int64 `json:"cpuMilli"`
	Mem  int64 `json:"memBytes"`
}

func (c *kclient) metrics(ctx context.Context, kind, namespace string) (map[string]Usage, error) {
	path := "/apis/metrics.k8s.io/v1beta1/nodes"
	if kind == "pods" {
		path = "/apis/metrics.k8s.io/v1beta1/pods"
		if namespace != "" {
			path = "/apis/metrics.k8s.io/v1beta1/namespaces/" + namespace + "/pods"
		}
	}
	raw, err := c.cs.Discovery().RESTClient().Get().AbsPath(path).Do(ctx).Raw()
	if err != nil {
		return nil, err
	}
	var ml metricsList
	if err := json.Unmarshal(raw, &ml); err != nil {
		return nil, err
	}
	out := map[string]Usage{}
	for _, it := range ml.Items {
		u := Usage{}
		add := func(m map[string]resource.Quantity) {
			if q, ok := m["cpu"]; ok {
				u.CPUm += q.MilliValue()
			}
			if q, ok := m["memory"]; ok {
				u.Mem += q.Value()
			}
		}
		if len(it.Containers) > 0 {
			for _, ct := range it.Containers {
				add(ct.Usage)
			}
		} else {
			add(it.Usage)
		}
		key := it.Metadata.Name
		if it.Metadata.Namespace != "" {
			key = it.Metadata.Namespace + "/" + key
		}
		out[key] = u
	}
	return out, nil
}

func (a *App) handleMetrics(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	kind := r.PathValue("kind")
	if kind != "pods" && kind != "nodes" {
		badRequest(w, "kind: pods|nodes")
		return
	}
	m, err := c.metrics(r.Context(), kind, ns(r))
	if err != nil {
		writeJSON(w, 200, map[string]any{"available": false, "error": err.Error(), "items": map[string]Usage{}})
		return
	}
	writeJSON(w, 200, map[string]any{"available": true, "items": m})
}

// ---------------------------------------------------------------- overview

type NodeSummary struct {
	Name         string `json:"name"`
	Ready        bool   `json:"ready"`
	Unschedul    bool   `json:"unschedulable"`
	Roles        string `json:"roles"`
	Version      string `json:"version"`
	InstanceType string `json:"instanceType,omitempty"`
	Zone         string `json:"zone,omitempty"`
	Group        string `json:"group,omitempty"`
	Capacity     string `json:"capacityType,omitempty"`
	CPUAlloc     int64  `json:"cpuAllocMilli"`
	MemAlloc     int64  `json:"memAllocBytes"`
	CPUReq       int64  `json:"cpuReqMilli"`
	MemReq       int64  `json:"memReqBytes"`
	Pods         int    `json:"pods"`
	PodsAlloc    int64  `json:"podsAlloc"`
	Created      string `json:"created"`
	Usage        *Usage `json:"usage,omitempty"`
}

type PodProblem struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Reason    string `json:"reason"`
	Restarts  int32  `json:"restarts"`
	Phase     string `json:"phase"`
}

type DeployState struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Ready     int32  `json:"ready"`
	Desired   int32  `json:"desired"`
}

type Overview struct {
	Version     string         `json:"version,omitempty"`
	Platform    string         `json:"platform,omitempty"`
	Namespace   string         `json:"namespace,omitempty"`
	Namespaces  int            `json:"namespaces"`
	Nodes       []NodeSummary  `json:"nodes"`
	PodPhases   map[string]int `json:"podPhases"`
	PodTotal    int            `json:"podTotal"`
	Restarts    int32          `json:"restarts"`
	Problems    []PodProblem   `json:"problems"`
	DeployTotal int            `json:"deployTotal"`
	DeployOK    int            `json:"deployOk"`
	Degraded    []DeployState  `json:"degraded"`
	Warnings    []EventItem    `json:"warnings"`
	Metrics     bool           `json:"metrics"`
	Errors      []string       `json:"errors"`
}

func podProblem(p *corev1.Pod) (string, int32) {
	var restarts int32
	reason := ""
	for _, cs := range append(append([]corev1.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...) {
		restarts += cs.RestartCount
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" && cs.State.Waiting.Reason != "ContainerCreating" && cs.State.Waiting.Reason != "PodInitializing" {
			reason = cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 && p.Status.Phase != corev1.PodSucceeded {
			reason = firstNonEmpty(reason, cs.State.Terminated.Reason)
		}
	}
	if reason == "" {
		switch p.Status.Phase {
		case corev1.PodPending, corev1.PodFailed, corev1.PodUnknown:
			reason = firstNonEmpty(p.Status.Reason, string(p.Status.Phase))
		case corev1.PodRunning:
			for _, c := range p.Status.Conditions {
				if c.Type == corev1.PodReady && c.Status != corev1.ConditionTrue && p.DeletionTimestamp == nil {
					reason = "NotReady"
				}
			}
		}
	}
	if p.DeletionTimestamp != nil {
		reason = "Terminating"
	}
	return reason, restarts
}

func (a *App) handleOverview(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	namespace := ns(r)
	ov := Overview{Namespace: namespace, PodPhases: map[string]int{}, Problems: []PodProblem{}, Degraded: []DeployState{}, Nodes: []NodeSummary{}, Errors: []string{}}

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		nodes   *corev1.NodeList
		pods    *corev1.PodList
		nodeMet map[string]Usage
	)
	fail := func(what string, err error) {
		mu.Lock()
		defer mu.Unlock()
		ov.Errors = append(ov.Errors, what+": "+err.Error())
	}
	run := func(f func()) { wg.Add(1); go func() { defer wg.Done(); f() }() }

	// the version call doubles as an auth check: fail fast with a clear error
	v, err := c.cs.Discovery().ServerVersion()
	if err != nil {
		writeErr(w, err)
		return
	}
	ov.Version, ov.Platform = v.GitVersion, v.Platform

	run(func() {
		l, err := c.cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err != nil {
			fail("nodes", err)
			return
		}
		nodes = l
	})
	run(func() {
		l, err := c.cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
		if err != nil {
			fail("namespaces", err)
			return
		}
		mu.Lock()
		ov.Namespaces = len(l.Items)
		mu.Unlock()
	})
	run(func() {
		l, err := c.cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			fail("pods", err)
			return
		}
		pods = l
	})
	run(func() {
		l, err := c.cs.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			fail("deployments", err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		ov.DeployTotal = len(l.Items)
		for _, d := range l.Items {
			desired := int32(1)
			if d.Spec.Replicas != nil {
				desired = *d.Spec.Replicas
			}
			if d.Status.AvailableReplicas >= desired {
				ov.DeployOK++
			} else {
				ov.Degraded = append(ov.Degraded, DeployState{Namespace: d.Namespace, Name: d.Name, Ready: d.Status.AvailableReplicas, Desired: desired})
			}
		}
	})
	run(func() {
		l, err := c.cs.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{FieldSelector: "type=Warning"})
		if err != nil {
			fail("events", err)
			return
		}
		mu.Lock()
		ov.Warnings = toEvents(l.Items, 30)
		mu.Unlock()
	})
	run(func() {
		m, err := c.metrics(ctx, "nodes", "")
		if err == nil {
			nodeMet = m
		}
	})
	wg.Wait()

	type agg struct {
		cpu, mem int64
		pods     int
	}
	perNode := map[string]*agg{}
	if pods != nil {
		ov.PodTotal = len(pods.Items)
		for i := range pods.Items {
			p := &pods.Items[i]
			ov.PodPhases[string(p.Status.Phase)]++
			reason, restarts := podProblem(p)
			ov.Restarts += restarts
			if reason != "" || restarts >= 5 {
				ov.Problems = append(ov.Problems, PodProblem{Namespace: p.Namespace, Name: p.Name, Reason: firstNonEmpty(reason, "Restarts"), Restarts: restarts, Phase: string(p.Status.Phase)})
			}
			if p.Spec.NodeName == "" || p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
				continue
			}
			ag := perNode[p.Spec.NodeName]
			if ag == nil {
				ag = &agg{}
				perNode[p.Spec.NodeName] = ag
			}
			ag.pods++
			for _, ct := range p.Spec.Containers {
				ag.cpu += ct.Resources.Requests.Cpu().MilliValue()
				ag.mem += ct.Resources.Requests.Memory().Value()
			}
		}
		sort.Slice(ov.Problems, func(i, j int) bool { return ov.Problems[i].Restarts > ov.Problems[j].Restarts })
		if len(ov.Problems) > 25 {
			ov.Problems = ov.Problems[:25]
		}
	}
	if nodes != nil {
		for _, n := range nodes.Items {
			s := NodeSummary{
				Name: n.Name, Version: n.Status.NodeInfo.KubeletVersion, Unschedul: n.Spec.Unschedulable,
				InstanceType: n.Labels["node.kubernetes.io/instance-type"],
				Zone:         n.Labels["topology.kubernetes.io/zone"],
				Group:        firstNonEmpty(n.Labels["eks.amazonaws.com/nodegroup"], n.Labels["karpenter.sh/nodepool"], n.Labels["karpenter.sh/provisioner-name"]),
				Capacity:     firstNonEmpty(n.Labels["eks.amazonaws.com/capacityType"], n.Labels["karpenter.sh/capacity-type"]),
				CPUAlloc:     n.Status.Allocatable.Cpu().MilliValue(),
				MemAlloc:     n.Status.Allocatable.Memory().Value(),
				PodsAlloc:    n.Status.Allocatable.Pods().Value(),
				Created:      n.CreationTimestamp.UTC().Format(time.RFC3339),
			}
			var roles []string
			for l := range n.Labels {
				if strings.HasPrefix(l, "node-role.kubernetes.io/") {
					roles = append(roles, strings.TrimPrefix(l, "node-role.kubernetes.io/"))
				}
			}
			sort.Strings(roles)
			s.Roles = strings.Join(roles, ",")
			for _, cnd := range n.Status.Conditions {
				if cnd.Type == corev1.NodeReady {
					s.Ready = cnd.Status == corev1.ConditionTrue
				}
			}
			if ag := perNode[n.Name]; ag != nil {
				s.CPUReq, s.MemReq, s.Pods = ag.cpu, ag.mem, ag.pods
			}
			if u, ok := nodeMet[n.Name]; ok {
				uu := u
				s.Usage = &uu
			}
			ov.Nodes = append(ov.Nodes, s)
		}
		sort.Slice(ov.Nodes, func(i, j int) bool { return ov.Nodes[i].Name < ov.Nodes[j].Name })
	}
	ov.Metrics = nodeMet != nil
	writeJSON(w, 200, ov)
}

// ---------------------------------------------------------------- logs (SSE)

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	send := func(event, data string) {
		if event != "" {
			fmt.Fprintf(w, "event: %s\n", event)
		}
		fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}

	c, err := a.kube.Client(r.PathValue("ctx"))
	if err != nil {
		send("failure", err.Error())
		return
	}
	opts := &corev1.PodLogOptions{
		Container:  q.Get("container"),
		Follow:     q.Get("follow") == "1",
		Previous:   q.Get("previous") == "1",
		Timestamps: q.Get("timestamps") == "1",
	}
	tail := int64(500)
	if v, err := strconv.ParseInt(q.Get("tail"), 10, 64); err == nil {
		tail = v
	}
	if tail >= 0 {
		opts.TailLines = &tail
	}
	stream, err := c.cs.CoreV1().Pods(r.PathValue("ns")).GetLogs(r.PathValue("pod"), opts).Stream(r.Context())
	if err != nil {
		send("failure", err.Error())
		return
	}
	defer stream.Close()

	// heartbeat keeps proxies from closing idle streams
	done := make(chan struct{})
	defer close(done)
	var wmu sync.Mutex
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				wmu.Lock()
				fmt.Fprint(w, ": ping\n\n")
				if flusher != nil {
					flusher.Flush()
				}
				wmu.Unlock()
			}
		}
	}()

	br := bufio.NewReaderSize(stream, 64*1024)
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			wmu.Lock()
			send("", strings.TrimRight(line, "\r\n"))
			wmu.Unlock()
		}
		if err != nil {
			wmu.Lock()
			if err == io.EOF || r.Context().Err() != nil {
				send("end", "")
			} else {
				send("failure", err.Error())
			}
			wmu.Unlock()
			return
		}
	}
}

// ---------------------------------------------------------------- exec (websocket)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		o := r.Header.Get("Origin")
		if o == "" {
			return true
		}
		u, err := url.Parse(o)
		return err == nil && u.Host == r.Host
	},
}

type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

type sizeQueue struct {
	ctx context.Context
	ch  chan remotecommand.TerminalSize
}

func (s *sizeQueue) Next() *remotecommand.TerminalSize {
	select {
	case <-s.ctx.Done():
		return nil
	case sz := <-s.ch:
		return &sz
	}
}

func (a *App) handleExec(w http.ResponseWriter, r *http.Request) {
	c, ok := a.client(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	cmd := q["cmd"]
	if len(cmd) == 0 {
		cmd = []string{"/bin/sh", "-c", "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"}
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	out := &wsWriter{conn: conn}

	req := c.cs.CoreV1().RESTClient().Post().Resource("pods").
		Namespace(r.PathValue("ns")).Name(r.PathValue("pod")).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: q.Get("container"), Command: cmd,
			Stdin: true, Stdout: true, Stderr: false, TTY: true,
		}, scheme.ParameterCodec)
	// Same strategy as kubectl >= 1.30: WebSocket first (works through HTTP/2
	// proxies / load balancers that strip the SPDY upgrade), SPDY as fallback.
	executor, err := newExecExecutor(c.cfg, req.URL())
	if err != nil {
		_, _ = out.Write([]byte("\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stdinR, stdinW := io.Pipe()
	sizes := &sizeQueue{ctx: ctx, ch: make(chan remotecommand.TerminalSize, 8)}

	go func() {
		defer cancel()
		defer stdinW.Close()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m struct {
				Type string `json:"type"`
				Data string `json:"data"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			switch m.Type {
			case "stdin":
				if _, err := stdinW.Write([]byte(m.Data)); err != nil {
					return
				}
			case "resize":
				select {
				case sizes.ch <- remotecommand.TerminalSize{Width: m.Cols, Height: m.Rows}:
				default:
				}
			}
		}
	}()

	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin: stdinR, Stdout: out, Tty: true, TerminalSizeQueue: sizes,
	})
	if err != nil && ctx.Err() == nil {
		_, _ = out.Write([]byte("\r\n\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
	} else {
		_, _ = out.Write([]byte("\r\n\x1b[90m[session terminée]\x1b[0m\r\n"))
	}
	out.mu.Lock()
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	out.mu.Unlock()
}

func newExecExecutor(cfg *rest.Config, u *url.URL) (remotecommand.Executor, error) {
	spdyExec, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	wsExec, err := remotecommand.NewWebSocketExecutor(cfg, "GET", u.String())
	if err != nil {
		return spdyExec, nil
	}
	return remotecommand.NewFallbackExecutor(wsExec, spdyExec, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	})
}
