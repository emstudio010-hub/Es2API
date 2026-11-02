package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type integrationRouteUsers struct{ service.UserRepository }

func (*integrationRouteUsers) GetByID(_ context.Context, id int64) (*service.User, error) {
	role := service.RoleAdmin
	if id == 2 {
		role = service.RoleUser
	}
	return &service.User{ID: id, Role: role, Status: service.StatusActive, TokenVersion: 1, TokenVersionResolved: true}, nil
}

func (*integrationRouteUsers) GetUserAvatar(context.Context, int64) (*service.UserAvatar, error) {
	return nil, nil
}

func integrationAuthenticatedRouter(t *testing.T) (*gin.Engine, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "integration-route-test-only-secret", ExpireHour: 1}}
	auth := service.NewAuthService(nil, nil, nil, nil, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
	users := service.NewUserService(&integrationRouteUsers{}, nil, nil, nil)
	adminToken, err := auth.GenerateToken(context.Background(), &service.User{ID: 1, Role: service.RoleAdmin, TokenVersion: 1, TokenVersionResolved: true})
	require.NoError(t, err)
	userToken, err := auth.GenerateToken(context.Background(), &service.User{ID: 2, Role: service.RoleUser, TokenVersion: 1, TokenVersionResolved: true})
	require.NoError(t, err)
	r := gin.New()
	RegisterAdminRoutes(r.Group("/api/v1"), &handler.Handlers{Admin: &handler.AdminHandlers{}},
		middleware.NewAdminAuthMiddleware(auth, users, nil, nil),
		middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.StepUpAuthMiddleware(func(c *gin.Context) { c.Next() }), nil, nil)
	return r, adminToken, userToken
}

func TestIntegrationProxyRegisteredRoutesRequireRealAdminAuthentication(t *testing.T) {
	var upstreamRequests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upstreamRequests.Add(1)
		if req.Header.Get("Authorization") != "Bearer integration-service-test-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"data":[]}`)
	}))
	defer upstream.Close()
	t.Setenv("ES2API_INTEGRATION_URL", upstream.URL)
	t.Setenv("ES2API_MANAGEMENT_TOKEN", "integration-service-test-secret")
	r, adminToken, userToken := integrationAuthenticatedRouter(t)
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/accounts"}, {http.MethodPost, "/accounts"},
		{http.MethodGet, "/accounts/test-id"}, {http.MethodPut, "/accounts/test-id"}, {http.MethodDelete, "/accounts/test-id"},
		{http.MethodPost, "/accounts/test-id/retry"}, {http.MethodPost, "/accounts/test-id/retry-delete"}, {http.MethodPost, "/accounts/test-id/sync"},
		{http.MethodGet, "/groups"}, {http.MethodPost, "/groups"}, {http.MethodPut, "/groups/test-id"}, {http.MethodDelete, "/groups/test-id"},
		{http.MethodGet, "/pool/stats"}, {http.MethodGet, "/modeltrace/config"}, {http.MethodPut, "/modeltrace/config"},
		{http.MethodGet, "/modeltrace/bank"}, {http.MethodPut, "/modeltrace/bank"}, {http.MethodGet, "/modeltrace/summary"},
		{http.MethodPost, "/modeltrace/run"}, {http.MethodGet, "/modeltrace/runs"}, {http.MethodGet, "/modeltrace/runs/test-id"},
		{http.MethodPost, "/modeltrace/runs/test-id/cancel"}, {http.MethodGet, "/accounts/test-id/modeltrace"},
		{http.MethodPut, "/accounts/test-id/modeltrace"}, {http.MethodPost, "/accounts/test-id/modeltrace/reset-action"},
	} {
		for _, tc := range []struct {
			token  string
			status int
		}{{"", 401}, {"invalid-token", 401}, {userToken, 403}, {adminToken, 200}} {
			before := upstreamRequests.Load()
			req := httptest.NewRequest(route.method, "/api/v1/admin/integration"+route.path, nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			require.Equal(t, tc.status, w.Code, route.method+" "+route.path+" "+w.Body.String())
			if tc.status != 200 {
				require.Equal(t, before, upstreamRequests.Load(), "denied request reached integration")
			}
		}
	}
}

func TestIntegrationProxyRouteAllowlistAndDisabledState(t *testing.T) {
	t.Setenv("ES2API_INTEGRATION_URL", "")
	t.Setenv("ES2API_MANAGEMENT_TOKEN", "")
	r, adminToken, _ := integrationAuthenticatedRouter(t)
	for _, route := range []struct {
		method, path string
		status       int
	}{
		{http.MethodGet, "/accounts", 503},
		{http.MethodPatch, "/accounts/id", 404},
		{http.MethodGet, "/health", 404},
		{http.MethodPost, "/pool/acquire", 404},
		{http.MethodPost, "/pool/release", 404},
		{http.MethodPost, "/usage/success", 404},
		{http.MethodGet, "/proxy/http://example.invalid", 404},
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(route.method, "/api/v1/admin/integration"+route.path, nil)
		req.Header.Set("Authorization", "Bearer "+adminToken)
		r.ServeHTTP(w, req)
		require.Equal(t, route.status, w.Code, route.path+" "+w.Body.String())
		if route.status == 503 {
			require.Contains(t, w.Body.String(), "integration_not_configured")
		}
	}
}
