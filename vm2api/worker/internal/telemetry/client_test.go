package telemetry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPostBatchHitsOfficialPathAndDropsSecretsFromConfigHeaders(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotBody BatchRequest
	var gotUA string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotUA = r.Header.Get("User-Agent")
		if r.Header.Get("X-Api-Key") != "" {
			t.Error("x-api-key must not be forwarded")
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	base, _ := url.Parse(server.URL)
	client := &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second}
	ev := InitEvent(Identity{DeviceID: "d1", Platform: "linux"}, time.Unix(1, 0).UTC())
	err := client.PostBatch(context.Background(), "slot-access", map[string]string{
		"User-Agent":    "claude-cli/2.1.233 (external, cli)",
		"x-app":         "cli",
		"Authorization": "Bearer leaked",
		"x-api-key":     "sk-leak",
		"Cookie":        "session=1",
	}, []Event{ev})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != batchPath {
		t.Fatalf("path=%q want %q", gotPath, batchPath)
	}
	if gotAuth != "Bearer slot-access" {
		t.Fatalf("authorization was not the live slot token")
	}
	if gotUA != "claude-cli/2.1.233 (external, cli)" {
		t.Fatalf("ua=%q", gotUA)
	}
	if len(gotBody.Events) != 1 || gotBody.Events[0].EventType != eventTypeInternal {
		t.Fatalf("body=%+v", gotBody)
	}
	if gotBody.Events[0].EventData["event_name"] != eventTenguInit {
		t.Fatalf("event_name=%v", gotBody.Events[0].EventData["event_name"])
	}
}

func TestPostBatch4xxIsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != batchPath {
			t.Fatalf("path=%q", r.URL.Path)
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client := &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: time.Second}
	err := client.PostBatch(context.Background(), "tok", nil, []Event{InitEvent(Identity{}, time.Now())})
	if err == nil {
		t.Fatal("expected 4xx error")
	}
}

func TestClassifyBatchErrIsLogSafe(t *testing.T) {
	class, status := ClassifyBatchErr(fmt.Errorf("event_logging/batch status 403 type=invalid_request_error"))
	if class != "status" || status != 403 {
		t.Fatalf("class=%s status=%d", class, status)
	}
	class, status = ClassifyBatchErr(context.DeadlineExceeded)
	if class != "timeout" || status != 0 {
		t.Fatalf("timeout class=%s status=%d", class, status)
	}
	class, _ = ClassifyBatchErr(fmt.Errorf("socks5h://user:secret@10.0.0.1:1080 dial"))
	if class != "socks" {
		t.Fatalf("socks class=%s", class)
	}
}

func TestPostBatchTimeoutIsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client := &Client{HTTP: server.Client(), AnthropicBase: base, Timeout: 20 * time.Millisecond}
	err := client.PostBatch(context.Background(), "tok", nil, []Event{InitEvent(Identity{}, time.Now())})
	if err == nil {
		t.Fatal("expected timeout")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "deadline") && !strings.Contains(strings.ToLower(err.Error()), "timeout") && !strings.Contains(strings.ToLower(err.Error()), "context") {
		t.Fatalf("unexpected error: %v", err)
	}
}
