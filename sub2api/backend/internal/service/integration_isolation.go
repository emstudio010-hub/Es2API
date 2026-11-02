package service

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// Only a published integration source receives this private caller namespace.
// Never trust a header supplied by a public API client or a header override.
func applyIntegrationCallerIsolation(c *gin.Context, account *Account, headers http.Header) {
	headers.Del("X-Es2api-Caller")
	headers.Del("X-Es2api-Connection")
	if account == nil || account.Extra["integration_gateway_group"] == nil {
		return
	}
	keyID := getAPIKeyIDFromContext(c)
	if keyID < 1 {
		return // The private gateway rejects a request without a caller namespace.
	}
	mac := hmac.New(sha256.New, []byte(account.GetCredential("api_key")))
	_, _ = mac.Write([]byte("es2api-caller-v1:" + strconv.FormatInt(keyID, 10)))
	headers.Set("X-Es2api-Caller", hex.EncodeToString(mac.Sum(nil)))
	// Anonymous sessions must not share a pooled WebSocket just because they
	// use the same upstream source. Explicit sessions retain connection reuse.
	if headers.Get("session_id") == "" && headers.Get("conversation_id") == "" {
		var nonce [24]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			panic("integration connection entropy unavailable")
		}
		headers.Set("X-Es2api-Connection", hex.EncodeToString(nonce[:]))
	}
}
