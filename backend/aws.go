package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/ssooidc"
	oidctypes "github.com/aws/aws-sdk-go-v2/service/ssooidc/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"gopkg.in/ini.v1"
)

type Profile struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"` // sso | static | assume-role | other
	Region      string   `json:"region,omitempty"`
	SSOSession  string   `json:"ssoSession,omitempty"`
	SSOStartURL string   `json:"ssoStartUrl,omitempty"`
	SSORegion   string   `json:"ssoRegion,omitempty"`
	AccountID   string   `json:"accountId,omitempty"`
	RoleName    string   `json:"roleName,omitempty"`
	RoleArn     string   `json:"roleArn,omitempty"`
	Source      string   `json:"sourceProfile,omitempty"`
	Scopes      []string `json:"-"`
}

type LoginState struct {
	ID              string    `json:"id"`
	Profile         string    `json:"profile"`
	Status          string    `json:"status"` // pending | success | error | expired
	Error           string    `json:"error,omitempty"`
	VerificationURI string    `json:"verificationUri"`
	UserCode        string    `json:"userCode"`
	ExpiresAt       time.Time `json:"expiresAt"`
}

type ProfileStatus struct {
	Profile         string     `json:"profile"`
	LoggedIn        bool       `json:"loggedIn"`
	SSOExpiresAt    *time.Time `json:"ssoExpiresAt,omitempty"`
	Account         string     `json:"account,omitempty"`
	Arn             string     `json:"arn,omitempty"`
	Error           string     `json:"error,omitempty"`
	RequiresSSO     bool       `json:"requiresSso"`
	CheckedIdentity bool       `json:"checkedIdentity"`
}

type cachedToken struct {
	token string
	exp   time.Time
}

type AWSManager struct {
	dir string

	mu      sync.Mutex
	cfgs    map[string]aws.Config
	tokens  map[string]cachedToken
	logins  map[string]*LoginState
	identMu sync.Mutex
	ident   map[string]ProfileStatus
	identAt map[string]time.Time
}

func NewAWSManager(dir string) *AWSManager {
	return &AWSManager{
		dir:     dir,
		cfgs:    map[string]aws.Config{},
		tokens:  map[string]cachedToken{},
		logins:  map[string]*LoginState{},
		ident:   map[string]ProfileStatus{},
		identAt: map[string]time.Time{},
	}
}

// ---------------------------------------------------------------- profiles

func (m *AWSManager) Profiles() ([]Profile, error) {
	opts := ini.LoadOptions{AllowBooleanKeys: true, SkipUnrecognizableLines: true, Insensitive: false}
	profiles := map[string]*Profile{}
	sessions := map[string]*ini.Section{}

	cfgPath := filepath.Join(m.dir, "config")
	if f, err := ini.LoadSources(opts, cfgPath); err == nil {
		for _, s := range f.Sections() {
			name := strings.TrimSpace(s.Name())
			switch {
			case name == "default":
				profiles["default"] = profileFromSection("default", s)
			case strings.HasPrefix(name, "profile "):
				n := strings.TrimSpace(strings.TrimPrefix(name, "profile "))
				profiles[n] = profileFromSection(n, s)
			case strings.HasPrefix(name, "sso-session "):
				sessions[strings.TrimSpace(strings.TrimPrefix(name, "sso-session "))] = s
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("reading %s: %w", cfgPath, err)
	}

	credPath := filepath.Join(m.dir, "credentials")
	if f, err := ini.LoadSources(opts, credPath); err == nil {
		for _, s := range f.Sections() {
			n := strings.TrimSpace(s.Name())
			if n == ini.DefaultSection || !s.HasKey("aws_access_key_id") {
				continue
			}
			if p, ok := profiles[n]; ok {
				if p.Type == "other" {
					p.Type = "static"
				}
			} else {
				profiles[n] = &Profile{Name: n, Type: "static"}
			}
		}
	}

	out := make([]Profile, 0, len(profiles))
	for _, p := range profiles {
		if p.SSOSession != "" {
			if s, ok := sessions[p.SSOSession]; ok {
				p.SSOStartURL = val(s, "sso_start_url")
				p.SSORegion = val(s, "sso_region")
				if sc := val(s, "sso_registration_scopes"); sc != "" {
					for _, x := range strings.Split(sc, ",") {
						if x = strings.TrimSpace(x); x != "" {
							p.Scopes = append(p.Scopes, x)
						}
					}
				}
			}
			if len(p.Scopes) == 0 {
				p.Scopes = []string{"sso:account:access"}
			}
		}
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func val(s *ini.Section, k string) string {
	if !s.HasKey(k) {
		return ""
	}
	return strings.TrimSpace(s.Key(k).String())
}

func profileFromSection(name string, s *ini.Section) *Profile {
	p := &Profile{
		Name:        name,
		Region:      val(s, "region"),
		SSOSession:  val(s, "sso_session"),
		SSOStartURL: val(s, "sso_start_url"),
		SSORegion:   val(s, "sso_region"),
		AccountID:   val(s, "sso_account_id"),
		RoleName:    val(s, "sso_role_name"),
		RoleArn:     val(s, "role_arn"),
		Source:      val(s, "source_profile"),
		Type:        "other",
	}
	switch {
	case p.SSOSession != "" || p.SSOStartURL != "":
		p.Type = "sso"
	case p.RoleArn != "":
		p.Type = "assume-role"
	case s.HasKey("aws_access_key_id"):
		p.Type = "static"
	}
	return p
}

func (m *AWSManager) profile(name string) (*Profile, error) {
	ps, err := m.Profiles()
	if err != nil {
		return nil, err
	}
	for i := range ps {
		if ps[i].Name == name {
			return &ps[i], nil
		}
	}
	return nil, fmt.Errorf("profil AWS %q introuvable dans %s", name, m.dir)
}

// ssoProfileFor walks source_profile chains to find the SSO profile that
// ultimately provides credentials (so "login" works for assume-role profiles).
func (m *AWSManager) ssoProfileFor(name string) (*Profile, error) {
	seen := map[string]bool{}
	for !seen[name] {
		seen[name] = true
		p, err := m.profile(name)
		if err != nil {
			return nil, err
		}
		if p.Type == "sso" {
			return p, nil
		}
		if p.Source == "" {
			return nil, nil
		}
		name = p.Source
	}
	return nil, nil
}

// ---------------------------------------------------------------- SSO cache

type ssoCacheFile struct {
	StartURL              string `json:"startUrl"`
	Region                string `json:"region"`
	AccessToken           string `json:"accessToken"`
	ExpiresAt             string `json:"expiresAt"`
	ClientID              string `json:"clientId,omitempty"`
	ClientSecret          string `json:"clientSecret,omitempty"`
	RegistrationExpiresAt string `json:"registrationExpiresAt,omitempty"`
	RefreshToken          string `json:"refreshToken,omitempty"`
}

// Same key derivation as the AWS CLI / SDKs: sha1(session name) for
// sso-session profiles, sha1(start url) for legacy profiles.
func (m *AWSManager) ssoCachePath(p *Profile) string {
	key := p.SSOStartURL
	if p.SSOSession != "" {
		key = p.SSOSession
	}
	h := sha1.Sum([]byte(key))
	return filepath.Join(m.dir, "sso", "cache", hex.EncodeToString(h[:])+".json")
}

func (m *AWSManager) readSSOCache(p *Profile) (*ssoCacheFile, time.Time, error) {
	b, err := os.ReadFile(m.ssoCachePath(p))
	if err != nil {
		return nil, time.Time{}, err
	}
	var c ssoCacheFile
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, time.Time{}, err
	}
	exp, err := parseAWSTime(c.ExpiresAt)
	return &c, exp, err
}

func parseAWSTime(s string) (time.Time, error) {
	for _, l := range []string{time.RFC3339, "2006-01-02T15:04:05UTC", "2006-01-02T15:04:05Z0700"} {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("format de date inconnu: %s", s)
}

func (m *AWSManager) writeSSOCache(p *Profile, c ssoCacheFile) error {
	path := m.ssoCachePath(p)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path + ".viewks.tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (m *AWSManager) invalidate() {
	m.mu.Lock()
	m.cfgs = map[string]aws.Config{}
	m.tokens = map[string]cachedToken{}
	m.mu.Unlock()
	m.identMu.Lock()
	m.ident = map[string]ProfileStatus{}
	m.identAt = map[string]time.Time{}
	m.identMu.Unlock()
}

// ---------------------------------------------------------------- device-code login

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *AWSManager) StartLogin(ctx context.Context, profileName string) (*LoginState, error) {
	p, err := m.ssoProfileFor(profileName)
	if err != nil {
		return nil, err
	}
	if p == nil || p.SSOStartURL == "" || p.SSORegion == "" {
		return nil, fmt.Errorf("le profil %q n'est pas un profil SSO (sso_start_url/sso_region manquants)", profileName)
	}

	oidc := ssooidc.NewFromConfig(aws.Config{Region: p.SSORegion})
	regIn := &ssooidc.RegisterClientInput{ClientName: aws.String("viewks"), ClientType: aws.String("public")}
	if p.SSOSession != "" {
		regIn.Scopes = p.Scopes
	}
	reg, err := oidc.RegisterClient(ctx, regIn)
	if err != nil {
		return nil, fmt.Errorf("RegisterClient: %w", err)
	}
	auth, err := oidc.StartDeviceAuthorization(ctx, &ssooidc.StartDeviceAuthorizationInput{
		ClientId: reg.ClientId, ClientSecret: reg.ClientSecret, StartUrl: aws.String(p.SSOStartURL),
	})
	if err != nil {
		return nil, fmt.Errorf("StartDeviceAuthorization: %w", err)
	}

	st := &LoginState{
		ID:              randomID(),
		Profile:         profileName,
		Status:          "pending",
		VerificationURI: aws.ToString(auth.VerificationUriComplete),
		UserCode:        aws.ToString(auth.UserCode),
		ExpiresAt:       time.Now().Add(time.Duration(auth.ExpiresIn) * time.Second),
	}
	if st.VerificationURI == "" {
		st.VerificationURI = aws.ToString(auth.VerificationUri)
	}
	m.mu.Lock()
	m.logins[st.ID] = st
	m.mu.Unlock()

	go m.pollLogin(st, p, oidc, reg, auth)
	return m.copyLogin(st), nil
}

func (m *AWSManager) setLogin(st *LoginState, status, msg string) {
	m.mu.Lock()
	st.Status, st.Error = status, msg
	m.mu.Unlock()
}

func (m *AWSManager) copyLogin(st *LoginState) *LoginState {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := *st
	return &c
}

func (m *AWSManager) Login(id string) (*LoginState, bool) {
	m.mu.Lock()
	st, ok := m.logins[id]
	m.mu.Unlock()
	if !ok {
		return nil, false
	}
	return m.copyLogin(st), true
}

func (m *AWSManager) pollLogin(st *LoginState, p *Profile, oidc *ssooidc.Client,
	reg *ssooidc.RegisterClientOutput, auth *ssooidc.StartDeviceAuthorizationOutput) {

	interval := time.Duration(auth.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ctx, cancel := context.WithDeadline(context.Background(), st.ExpiresAt)
	defer cancel()

	for {
		select {
		case <-ctx.Done():
			m.setLogin(st, "expired", "le code d'autorisation a expiré, relance la connexion")
			return
		case <-time.After(interval):
		}
		tok, err := oidc.CreateToken(ctx, &ssooidc.CreateTokenInput{
			ClientId:     reg.ClientId,
			ClientSecret: reg.ClientSecret,
			DeviceCode:   auth.DeviceCode,
			GrantType:    aws.String("urn:ietf:params:oauth:grant-type:device_code"),
		})
		if err != nil {
			var pending *oidctypes.AuthorizationPendingException
			var slow *oidctypes.SlowDownException
			switch {
			case errors.As(err, &pending):
				continue
			case errors.As(err, &slow):
				interval += 5 * time.Second
				continue
			case ctx.Err() != nil:
				m.setLogin(st, "expired", "le code d'autorisation a expiré, relance la connexion")
			default:
				m.setLogin(st, "error", err.Error())
			}
			return
		}

		c := ssoCacheFile{
			StartURL:    p.SSOStartURL,
			Region:      p.SSORegion,
			AccessToken: aws.ToString(tok.AccessToken),
			ExpiresAt:   time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).UTC().Format(time.RFC3339),
		}
		if p.SSOSession != "" {
			c.ClientID = aws.ToString(reg.ClientId)
			c.ClientSecret = aws.ToString(reg.ClientSecret)
			c.RegistrationExpiresAt = time.Unix(reg.ClientSecretExpiresAt, 0).UTC().Format(time.RFC3339)
			c.RefreshToken = aws.ToString(tok.RefreshToken)
		}
		if err := m.writeSSOCache(p, c); err != nil {
			m.setLogin(st, "error", "écriture du cache SSO impossible: "+err.Error())
			return
		}
		m.invalidate()
		m.setLogin(st, "success", "")
		return
	}
}

func (m *AWSManager) Logout(profileName string) error {
	p, err := m.ssoProfileFor(profileName)
	if err != nil {
		return err
	}
	if p == nil {
		return fmt.Errorf("le profil %q n'est pas un profil SSO", profileName)
	}
	err = os.Remove(m.ssoCachePath(p))
	m.invalidate()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ---------------------------------------------------------------- credentials / status

func (m *AWSManager) Config(ctx context.Context, profile string) (aws.Config, error) {
	m.mu.Lock()
	cfg, ok := m.cfgs[profile]
	m.mu.Unlock()
	if ok {
		return cfg, nil
	}
	opts := []func(*config.LoadOptions) error{
		config.WithSharedConfigFiles([]string{filepath.Join(m.dir, "config")}),
		config.WithSharedCredentialsFiles([]string{filepath.Join(m.dir, "credentials")}),
	}
	if profile != "" {
		opts = append(opts, config.WithSharedConfigProfile(profile))
	}
	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return cfg, err
	}
	m.mu.Lock()
	m.cfgs[profile] = cfg
	m.mu.Unlock()
	return cfg, nil
}

func (m *AWSManager) Status(ctx context.Context, profileName string, checkIdentity bool) ProfileStatus {
	st := ProfileStatus{Profile: profileName}
	sp, err := m.ssoProfileFor(profileName)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	if sp != nil {
		st.RequiresSSO = true
		_, exp, err := m.readSSOCache(sp)
		if err != nil || time.Now().After(exp) {
			st.Error = "session SSO absente ou expirée"
			return st
		}
		st.SSOExpiresAt = &exp
		st.LoggedIn = true
	}
	if !checkIdentity {
		return st
	}

	m.identMu.Lock()
	if c, ok := m.ident[profileName]; ok && time.Since(m.identAt[profileName]) < time.Minute {
		m.identMu.Unlock()
		c.SSOExpiresAt = st.SSOExpiresAt
		return c
	}
	m.identMu.Unlock()

	st.CheckedIdentity = true
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cfg, err := m.Config(cctx, profileName)
	if err == nil {
		var out *sts.GetCallerIdentityOutput
		out, err = sts.NewFromConfig(cfg).GetCallerIdentity(cctx, &sts.GetCallerIdentityInput{})
		if err == nil {
			st.LoggedIn = true
			st.Account = aws.ToString(out.Account)
			st.Arn = aws.ToString(out.Arn)
		}
	}
	if err != nil {
		st.LoggedIn = false
		st.Error = err.Error()
	}
	m.identMu.Lock()
	m.ident[profileName] = st
	m.identAt[profileName] = time.Now()
	m.identMu.Unlock()
	return st
}

// ---------------------------------------------------------------- EKS token

// AuthError marks failures to obtain AWS credentials (=> UI shows "reconnect").
type AuthError struct{ Err error }

func (e *AuthError) Error() string { return "aws-auth: " + e.Err.Error() }
func (e *AuthError) Unwrap() error { return e.Err }

// EKSToken produces the same bearer token as `aws eks get-token`:
// a presigned STS GetCallerIdentity URL carrying the x-k8s-aws-id header.
func (m *AWSManager) EKSToken(ctx context.Context, profile, region, cluster, roleArn string) (string, error) {
	key := strings.Join([]string{profile, region, cluster, roleArn}, "|")
	m.mu.Lock()
	if t, ok := m.tokens[key]; ok && time.Until(t.exp) > time.Minute {
		m.mu.Unlock()
		return t.token, nil
	}
	m.mu.Unlock()

	cfg, err := m.Config(ctx, profile)
	if err != nil {
		return "", &AuthError{err}
	}
	cfg = cfg.Copy()
	if region != "" {
		cfg.Region = region
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	if roleArn != "" {
		cfg.Credentials = aws.NewCredentialsCache(stscreds.NewAssumeRoleProvider(sts.NewFromConfig(cfg), roleArn))
	}

	presign := sts.NewPresignClient(sts.NewFromConfig(cfg))
	req, err := presign.PresignGetCallerIdentity(ctx, &sts.GetCallerIdentityInput{}, func(po *sts.PresignOptions) {
		po.ClientOptions = append(po.ClientOptions, func(o *sts.Options) {
			o.APIOptions = append(o.APIOptions,
				smithyhttp.AddHeaderValue("x-k8s-aws-id", cluster),
				smithyhttp.AddHeaderValue("X-Amz-Expires", "60"),
			)
		})
	})
	if err != nil {
		return "", &AuthError{err}
	}
	tok := "k8s-aws-v1." + base64.RawURLEncoding.EncodeToString([]byte(req.URL))
	m.mu.Lock()
	m.tokens[key] = cachedToken{token: tok, exp: time.Now().Add(14 * time.Minute)}
	m.mu.Unlock()
	return tok, nil
}
