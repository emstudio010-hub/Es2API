package admin

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func integrationProxyTestRouter(h *IntegrationProxyHandler, method, path string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Handle(method, "/api/v1/admin/integration"+path, h.Handle(path))
	return r
}

func TestIntegrationProxyForwardsOnlyServerCredentialsAndPreservesContract(t *testing.T) {
	var captured *http.Request
	var capturedBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		captured = req.Clone(req.Context())
		body, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		capturedBody = string(body)
		w.Header().Set("X-Request-ID", "integration-request-id")
		w.Header().Set("Set-Cookie", "private=must-not-leak")
		w.Header().Set("Location", "https://must-not-forward.invalid")
		w.Header().Set("Cache-Control", "public")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"ok":true,"data":{"id":"created-account"}}`)
	}))
	defer upstream.Close()
	r := integrationProxyTestRouter(NewIntegrationProxyHandler(upstream.URL, "server-only-test-token"), http.MethodPost, "/accounts")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/integration/accounts?mode=shared&group_id=a%20b", strings.NewReader(`{"name":"test","credential":{"access_token":"synthetic"}}`))
	req.Header.Set("Authorization", "Bearer browser-jwt")
	req.Header.Set("Cookie", "session=browser-session")
	req.Header.Set("X-API-Key", "browser-key")
	req.Header.Set("X-Forwarded-Host", "untrusted.invalid")
	req.Header.Set("Idempotency-Key", "import-repeatable-key")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, `{"ok":true,"data":{"id":"created-account"}}`, w.Body.String())
	require.Equal(t, "/api/v1/admin/accounts", captured.URL.Path)
	require.Equal(t, "mode=shared&group_id=a%20b", captured.URL.RawQuery)
	require.Equal(t, "Bearer server-only-test-token", captured.Header.Get("Authorization"))
	require.Equal(t, "import-repeatable-key", captured.Header.Get("Idempotency-Key"))
	for _, header := range []string{"Cookie", "X-API-Key", "X-Forwarded-Host"} {
		require.Empty(t, captured.Header.Get(header), header)
	}
	require.Equal(t, `{"name":"test","credential":{"access_token":"synthetic"}}`, capturedBody)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.Equal(t, "integration-request-id", w.Header().Get("X-Request-ID"))
	require.Empty(t, w.Header().Get("Set-Cookie"))
	require.Empty(t, w.Header().Get("Location"))
}

func TestIntegrationProxyRejectsMissingOrInvalidConfiguration(t *testing.T) {
	for _, tc := range []struct{ origin, token string }{
		{"", ""}, {"http://127.0.0.1:1", ""}, {"", "secret"},
		{"file:///tmp/service", "secret"}, {"http://user:pass@localhost", "secret"},
		{"http://localhost/private", "secret"}, {"http://localhost?token=x", "secret"},
		{"http://localhost#path", "secret"}, {"http://localhost", "bad\r\ntoken"},
	} {
		h := NewIntegrationProxyHandler(tc.origin, tc.token)
		w := httptest.NewRecorder()
		integrationProxyTestRouter(h, http.MethodGet, "/accounts").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/integration/accounts", nil))
		require.Equal(t, http.StatusServiceUnavailable, w.Code, tc.origin)
		require.Contains(t, w.Body.String(), "integration_not_configured")
	}
}

func TestIntegrationProxyPreservesApplicationErrorsButSeparatesServiceAuth(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusUnauthorized, http.StatusForbidden} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"ok":false,"error":{"code":"upstream_error","message":"upstream-detail"}}`)
		}))
		w := httptest.NewRecorder()
		r := integrationProxyTestRouter(NewIntegrationProxyHandler(upstream.URL, "server-token"), http.MethodGet, "/accounts")
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/integration/accounts", nil))
		upstream.Close()
		if status == 401 || status == 403 {
			require.Equal(t, http.StatusBadGateway, w.Code)
			require.Contains(t, w.Body.String(), "integration_auth_failed")
			require.NotContains(t, w.Body.String(), "upstream-detail")
		} else {
			require.Equal(t, status, w.Code)
			require.Contains(t, w.Body.String(), "upstream_error")
			require.Equal(t, "3", w.Header().Get("Retry-After"))
		}
	}
}

func TestIntegrationProxyRejectsRedirectsWithoutFollowing(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { redirected.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, target.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	w := httptest.NewRecorder()
	integrationProxyTestRouter(NewIntegrationProxyHandler(upstream.URL, "server-token"), http.MethodGet, "/accounts").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/integration/accounts", nil))
	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Contains(t, w.Body.String(), "integration_redirect_blocked")
	require.Zero(t, redirected.Load())
	require.Empty(t, w.Header().Get("Location"))
}

func TestIntegrationProxyLimitsRequestAndResponseBodies(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = io.WriteString(w, strings.Repeat("x", int(integrationResponseLimit+1)))
	}))
	defer upstream.Close()
	r := integrationProxyTestRouter(NewIntegrationProxyHandler(upstream.URL, "server-token"), http.MethodPost, "/accounts")
	for _, knownLength := range []bool{true, false} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/integration/accounts", strings.NewReader(strings.Repeat("x", int(integrationRequestLimit+1))))
		if !knownLength {
			req.ContentLength = -1
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
		require.Zero(t, requests.Load())
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/integration/accounts", strings.NewReader(`{}`)))
	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Contains(t, w.Body.String(), "integration_invalid_response")
}

func TestIntegrationProxyTimeoutAndResourceIDValidation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) { <-req.Context().Done() }))
	defer upstream.Close()
	h := NewIntegrationProxyHandler(upstream.URL, "server-token")
	h.client.Timeout = 10 * time.Millisecond
	r := integrationProxyTestRouter(h, http.MethodGet, "/accounts/:id")
	for _, id := range []string{"..", "%25encoded", "a%5Cb"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/integration/accounts/"+id, nil))
		require.Equal(t, http.StatusBadRequest, w.Code, id)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/admin/integration/accounts/valid-account", nil))
	require.Equal(t, http.StatusGatewayTimeout, w.Code)
	require.Contains(t, w.Body.String(), "integration_timeout")
}
