package routes

import (
	"net/http"

	adminhandler "github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/gin-gonic/gin"
)

// Keep this explicit allowlist under RegisterAdminRoutes' existing real admin
// authentication, audit, compliance, and rate limiting middleware. Scheduler
// acquire/release, usage ingestion, health and arbitrary upstream paths are not
// browser management APIs and are deliberately absent.
func registerIntegrationRoutes(admin *gin.RouterGroup) {
	h := adminhandler.NewIntegrationProxyHandlerFromEnv()
	integration := admin.Group("/integration")
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/accounts"},
		{http.MethodPost, "/accounts"},
		{http.MethodGet, "/accounts/:id"},
		{http.MethodPut, "/accounts/:id"},
		{http.MethodDelete, "/accounts/:id"},
		{http.MethodPost, "/accounts/:id/retry"},
		{http.MethodPost, "/accounts/:id/retry-delete"},
		{http.MethodPost, "/accounts/:id/sync"},
		{http.MethodGet, "/groups"},
		{http.MethodPost, "/groups"},
		{http.MethodPut, "/groups/:id"},
		{http.MethodDelete, "/groups/:id"},
		{http.MethodGet, "/pool/stats"},
		{http.MethodGet, "/modeltrace/config"},
		{http.MethodPut, "/modeltrace/config"},
		{http.MethodGet, "/modeltrace/bank"},
		{http.MethodPut, "/modeltrace/bank"},
		{http.MethodGet, "/modeltrace/summary"},
		{http.MethodPost, "/modeltrace/run"},
		{http.MethodGet, "/modeltrace/runs"},
		{http.MethodGet, "/modeltrace/runs/:id"},
		{http.MethodPost, "/modeltrace/runs/:id/cancel"},
		{http.MethodGet, "/accounts/:id/modeltrace"},
		{http.MethodPut, "/accounts/:id/modeltrace"},
		{http.MethodPost, "/accounts/:id/modeltrace/reset-action"},
	} {
		integration.Handle(route.method, route.path, h.Handle(route.path))
	}
}
