package admin

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
)

const (
	integrationRequestLimit  int64 = 10 * 1024 * 1024
	integrationResponseLimit int64 = 16 * 1024 * 1024
)

// IntegrationProxyHandler connects the authenticated admin panel to the private
// integration service. Credentials and the target origin come only from the Go
// server environment; neither is accepted from browser headers or parameters.
type IntegrationProxyHandler struct {
	origin *url.URL
	token  string
	client *http.Client
}

func NewIntegrationProxyHandlerFromEnv() *IntegrationProxyHandler {
	return NewIntegrationProxyHandler(os.Getenv("ES2API_INTEGRATION_URL"), os.Getenv("ES2API_MANAGEMENT_TOKEN"))
}

func NewIntegrationProxyHandler(origin, token string) *IntegrationProxyHandler {
	h := &IntegrationProxyHandler{}
	origin = strings.TrimSpace(origin)
	token = strings.TrimSpace(token)
	target, err := url.Parse(origin)
	if err != nil || target == nil || (target.Scheme != "http" && target.Scheme != "https") ||
		target.Hostname() == "" || target.User != nil || target.Opaque != "" ||
		(target.Path != "" && target.Path != "/") || target.RawQuery != "" || target.ForceQuery ||
		target.Fragment != "" || token == "" || strings.ContainsAny(token, "\r\n") {
		return h
	}
	h.origin = target
	h.token = token
	// Do not send a private management credential through ambient HTTP_PROXY.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.ResponseHeaderTimeout = 105 * time.Second
	transport.MaxIdleConnsPerHost = 8
	h.client = &http.Client{
		Transport: transport,
		Timeout:   110 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return h
}

// Handle receives a literal, allowlisted route from registration, never a URL
// supplied by the caller. Register it only inside the existing admin auth chain.
func (h *IntegrationProxyHandler) Handle(route string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		if h.origin == nil || h.client == nil {
			integrationProxyError(c, http.StatusServiceUnavailable, "integration_not_configured", "Integration 服务未配置，请在后端设置 ES2API_INTEGRATION_URL 和 ES2API_MANAGEMENT_TOKEN")
			return
		}
		path := route
		if strings.Contains(path, ":id") {
			id := c.Param("id")
			if id == "" || id == "." || id == ".." || len(id) > 200 ||
				strings.ContainsAny(id, "/\\%?#") || strings.IndexFunc(id, unicode.IsControl) >= 0 {
				integrationProxyError(c, http.StatusBadRequest, "invalid_resource_id", "资源 ID 无效")
				return
			}
			path = strings.ReplaceAll(path, ":id", id)
		}
		key := c.GetHeader("Idempotency-Key")
		if len(key) > 256 {
			integrationProxyError(c, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key 超过长度限制")
			return
		}
		if c.Request.ContentLength > integrationRequestLimit {
			integrationProxyError(c, http.StatusRequestEntityTooLarge, "body_too_large", "请求体超过 10 MiB 限制")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, integrationRequestLimit))
		if err != nil {
			var limitErr *http.MaxBytesError
			if errors.As(err, &limitErr) {
				integrationProxyError(c, http.StatusRequestEntityTooLarge, "body_too_large", "请求体超过 10 MiB 限制")
			} else {
				integrationProxyError(c, http.StatusBadRequest, "invalid_request_body", "无法读取请求体")
			}
			return
		}
		target := *h.origin
		target.Path = "/api/v1/admin" + path
		target.RawPath = ""
		target.RawQuery = c.Request.URL.RawQuery
		req, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, target.String(), bytes.NewReader(body))
		if err != nil {
			integrationProxyError(c, http.StatusBadGateway, "integration_request_failed", "无法建立 Integration 请求")
			return
		}
		// A new header map intentionally drops browser Authorization, Cookie,
		// x-api-key, forwarded headers, and all hop-by-hop headers.
		req.Header.Set("Authorization", "Bearer "+h.token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		res, err := h.client.Do(req)
		if err != nil {
			status, code, message := http.StatusBadGateway, "integration_unavailable", "Integration 服务不可用"
			var timeout net.Error
			if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
				status, code, message = http.StatusGatewayTimeout, "integration_timeout", "Integration 请求超时"
			}
			integrationProxyError(c, status, code, message)
			return
		}
		defer res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
			// These are service-to-service credential failures. A browser 401
			// would incorrectly sign an already authenticated administrator out.
			integrationProxyError(c, http.StatusBadGateway, "integration_auth_failed", "Integration 管理认证失败，请检查后端 ES2API_MANAGEMENT_TOKEN 配置")
			return
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			integrationProxyError(c, http.StatusBadGateway, "integration_redirect_blocked", "Integration 返回了不允许的重定向")
			return
		}
		responseBody, err := io.ReadAll(io.LimitReader(res.Body, integrationResponseLimit+1))
		var bodyTimeout net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &bodyTimeout) && bodyTimeout.Timeout()) {
			integrationProxyError(c, http.StatusGatewayTimeout, "integration_timeout", "Integration 请求超时")
			return
		}
		if err != nil || int64(len(responseBody)) > integrationResponseLimit {
			integrationProxyError(c, http.StatusBadGateway, "integration_invalid_response", "Integration 响应读取失败或超过 16 MiB 限制")
			return
		}
		for _, header := range []string{"X-Request-ID", "Retry-After"} {
			if value := res.Header.Get(header); value != "" {
				c.Header(header, value)
			}
		}
		// Do not forward Set-Cookie, Location, CORS or upstream cache headers.
		c.Data(res.StatusCode, "application/json; charset=utf-8", responseBody)
	}
}

func integrationProxyError(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"ok": false, "error": gin.H{"code": code, "message": message}})
}
