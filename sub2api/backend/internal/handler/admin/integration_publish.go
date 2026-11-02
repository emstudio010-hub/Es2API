package admin

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

var integrationPublicationLock sync.Mutex
var integrationGroupID = regexp.MustCompile(`^[a-zA-Z0-9._:-]{1,160}$`)

func (h *AccountHandler) IntegrationPublications(c *gin.Context) {
	if adminaccess.FromContext(c.Request.Context()) != nil {
		response.Error(c, 403, "需要完整管理员权限")
		return
	}
	accounts, err := h.adminService.ListAccountsForSchedulerScoreFilter(c.Request.Context(), "openai", "apikey", "", "", 0, "")
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	items := []gin.H{}
	for _, a := range accounts {
		if group, ok := a.Extra["integration_gateway_group"].(string); ok && group != "" {
			items = append(items, gin.H{"group_id": group, "native_account_id": a.ID, "native_group_ids": a.GroupIDs, "published": a.Schedulable && a.Status == "active"})
		}
	}
	c.JSON(200, gin.H{"ok": true, "data": items})
}

// PublishIntegrationGroup creates an ordinary native upstream account. Native
// authentication, quotas, model restrictions, concurrency, metering and billing
// therefore remain on the existing public gateway path. Pool selection and
// ModelTrace actions are enforced at the private execution boundary.
func (h *AccountHandler) PublishIntegrationGroup(c *gin.Context) {
	if adminaccess.FromContext(c.Request.Context()) != nil {
		response.Error(c, 403, "发布账号池需要完整管理员权限")
		return
	}
	id := c.Param("id")
	if !integrationGroupID.MatchString(id) {
		response.BadRequest(c, "无效的账号池分组")
		return
	}
	proxy := NewIntegrationProxyHandlerFromEnv()
	if proxy.origin == nil {
		response.Error(c, 503, "Integration 服务未配置")
		return
	}
	var input struct {
		NativeGroupID int64 `json:"native_group_id"`
		Concurrency   int   `json:"concurrency"`
	}
	if c.Request.Method != http.MethodDelete {
		if err := c.ShouldBindJSON(&input); err != nil || input.NativeGroupID < 1 {
			response.BadRequest(c, "请选择已有的 OpenAI 用户分组")
			return
		}
		group, err := h.adminService.GetGroup(c.Request.Context(), input.NativeGroupID)
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
		if group.Platform != "openai" {
			response.BadRequest(c, "执行账号池只能发布到 OpenAI 用户分组")
			return
		}
		if input.Concurrency < 1 {
			input.Concurrency = 10
		}
		if input.Concurrency > 256 {
			response.BadRequest(c, "并发上限不能超过 256")
			return
		}
		// Verify the execution group without exposing a management token to the UI.
		req, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, proxy.origin.String()+"/api/v1/admin/groups", nil)
		req.Header.Set("Authorization", "Bearer "+proxy.token)
		res, err := proxy.client.Do(req)
		if err != nil {
			response.Error(c, 503, "执行服务暂时不可用")
			return
		}
		defer res.Body.Close()
		var payload struct {
			OK   bool `json:"ok"`
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, integrationResponseLimit)).Decode(&payload) != nil || !payload.OK {
			response.Error(c, 503, "无法读取账号池分组")
			return
		}
		found := false
		for _, group := range payload.Data {
			if group.ID == id {
				found = true
				break
			}
		}
		if !found {
			response.Error(c, 404, "账号池分组不存在")
			return
		}
	}
	integrationPublicationLock.Lock()
	defer integrationPublicationLock.Unlock()
	accounts, err := h.adminService.ListAccountsForSchedulerScoreFilter(c.Request.Context(), "openai", "apikey", "", "", 0, "")
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	var existing *service.Account
	for i := range accounts {
		if accounts[i].Extra["integration_gateway_group"] == id {
			existing = &accounts[i]
			break
		}
	}
	if c.Request.Method == http.MethodDelete {
		if existing != nil {
			if _, err := h.adminService.SetAccountSchedulable(c.Request.Context(), existing.ID, false); err != nil {
				response.ErrorFrom(c, err)
				return
			}
		}
		c.JSON(200, gin.H{"ok": true, "data": gin.H{"published": false}})
		return
	}
	mac := hmac.New(sha256.New, []byte(proxy.token))
	_, _ = mac.Write([]byte("es2api-gateway-v1:" + id))
	credentials := map[string]any{"api_key": hex.EncodeToString(mac.Sum(nil)), "base_url": fmt.Sprintf("%s/gateway/%s", proxy.origin.String(), id)}
	extra := map[string]any{"integration_gateway_group": id, "openai_passthrough": true, "openai_responses_supported": true, "openai_responses_mode": "responses", "openai_apikey_responses_websockets_v2_enabled": true, "openai_apikey_responses_websockets_v2_mode": "passthrough", "probe_enabled": false}
	groups := []int64{input.NativeGroupID}
	probe := false
	var account *service.Account
	if existing == nil {
		account, err = h.adminService.CreateAccount(c.Request.Context(), &service.CreateAccountInput{Name: "VM2 / " + id, Platform: "openai", Type: "apikey", Credentials: credentials, Extra: extra, GroupIDs: groups, Concurrency: input.Concurrency, Priority: 1, ProbeEnabled: &probe})
	} else {
		account, err = h.adminService.UpdateAccount(c.Request.Context(), existing.ID, &service.UpdateAccountInput{Credentials: credentials, Extra: extra, GroupIDs: &groups, Concurrency: &input.Concurrency, ProbeEnabled: &probe})
		if err == nil {
			account, err = h.adminService.SetAccountSchedulable(c.Request.Context(), existing.ID, true)
		}
	}
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	// Return only routing identifiers, never the derived upstream credential.
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"published": true, "native_account_id": account.ID, "native_group_id": input.NativeGroupID}})
}
