package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestIntegrationProxyImportOmitsCredentialBodyFromAudit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repository := &auditCaptureRepository{}
	auditService := service.NewAuditLogService(repository, nil)
	auditService.Start()
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(string(ContextKeyUser), AuthSubject{UserID: 77})
		c.Set(string(ContextKeyUserRole), "admin")
		c.Next()
	})
	r.Use(gin.HandlerFunc(NewAuditLogMiddleware(auditService)))
	const payload = `{"auth_json":"{\"access_token\":\"audit-canary-import-secret\"}"}`
	var forwardedBody string
	r.POST("/api/v1/admin/integration/accounts", func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		require.NoError(t, err)
		forwardedBody = string(body)
		c.JSON(http.StatusCreated, gin.H{"ok": true})
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/integration/accounts", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	auditService.Stop()
	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, payload, forwardedBody, "audit must not alter the account import payload")
	repository.mu.Lock()
	defer repository.mu.Unlock()
	require.Len(t, repository.logs, 1)
	require.Equal(t, "<credential-bearing body omitted>", repository.logs[0].RequestBody)
	require.NotContains(t, repository.logs[0].RequestBody, "audit-canary")
	require.Equal(t, "/api/v1/admin/integration/accounts", repository.logs[0].Path)
}
