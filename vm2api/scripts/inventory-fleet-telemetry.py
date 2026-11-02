#!/usr/bin/env python3
"""Read-only fleet inventory. Prints counts and ids, never secrets."""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path("/opt/kin-gateway")
VMS = ROOT / "vms"
SKIP_HINT = os.environ.get("SKIP_IDS", "")

KILL = (
    "DISABLE_TELEMETRY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DO_NOT_TRACK",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)


def load(p):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return {}


def has_proxy(vm):
    px = vm.get("proxy") or {}
    return bool(px.get("host") and px.get("port"))


def official_ids(home):
    doc = load(home / ".claude.json")
    return bool(doc.get("userID") or doc.get("machineID"))


def sidecar_pids(name):
    try:
        out = subprocess.check_output(
            ["docker", "exec", name, "ps", "-eo", "pid,args"],
            text=True,
            timeout=8,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return {"worker": False, "sidecar": False}
    worker = False
    sidecar = False
    for line in out.splitlines():
        if "kin-worker" in line and "telemetry" in line:
            sidecar = True
        elif "kin-worker" in line:
            worker = True
    return {"worker": worker, "sidecar": sidecar}


def container_running(name):
    try:
        out = subprocess.check_output(
            ["docker", "inspect", "-f", "{{.State.Running}}", name],
            text=True,
            timeout=5,
            stderr=subprocess.DEVNULL,
        ).strip()
        return out == "true"
    except Exception:
        return False


rows = []
for p in sorted(VMS.glob("vm-*.json")):
    vm = load(p)
    vid = vm.get("id") or p.stem
    home = VMS / vid / "cli-home"
    worker = load(VMS / vid / "run" / "worker.json")
    settings = load(home / ".claude" / "settings.json")
    env = (settings.get("env") or {}) if isinstance(settings, dict) else {}
    tel = worker.get("telemetry") if isinstance(worker.get("telemetry"), dict) else {}
    seed = vm.get("seed_policy") or {}
    cl = vm.get("claude") or {}
    name = f"kin-{vid.split('-', 1)[-1]}"
    running = container_running(name)
    procs = sidecar_pids(name) if running else {"worker": False, "sidecar": False}
    rows.append({
        "id": vid,
        "schedulable": vm.get("schedulable") is not False,
        "status": vm.get("status"),
        "has_refresh": bool(cl.get("has_refresh") or cl.get("refresh_token") or cl.get("has_access")),
        "has_proxy": has_proxy(vm),
        "running": running,
        "worker_proc": procs["worker"],
        "sidecar_proc": procs["sidecar"],
        "tel_enabled": tel.get("enabled") is True,
        "tel_official": bool((tel.get("identity") or {}).get("user_id") or (tel.get("identity") or {}).get("device_id")),
        "official_json": official_ids(home),
        "seed_tel_on": seed.get("telemetry_disabled") is False,
        "kill_present": any(env.get(k) in ("1", 1, True) for k in KILL),
        "worker_proxy": bool(worker.get("proxy_url")),
    })

pool = [r for r in rows if r["schedulable"] and r["has_refresh"] and r["has_proxy"] and r["running"]]
# Prefer live dashboard later; this is disk/runtime projection.

def ids(xs):
    return [r["id"] for r in xs]

print("total", len(rows))
print("schedulable", len([r for r in rows if r["schedulable"]]))
print("has_refresh", len([r for r in rows if r["has_refresh"]]), ids([r for r in rows if r["has_refresh"]]))
print("has_proxy", len([r for r in rows if r["has_proxy"]]))
print("running", len([r for r in rows if r["running"]]), ids([r for r in rows if r["running"]]))
print("sidecar_proc", len([r for r in rows if r["sidecar_proc"]]), ids([r for r in rows if r["sidecar_proc"]]))
print("tel_enabled", len([r for r in rows if r["tel_enabled"]]), ids([r for r in rows if r["tel_enabled"]]))
print("official_json", len([r for r in rows if r["official_json"]]), ids([r for r in rows if r["official_json"]]))
print("seed_tel_on", len([r for r in rows if r["seed_tel_on"]]))
print("kill_present", len([r for r in rows if r["kill_present"]]))
print("disk_pool_like", len(pool), ids(pool))
print("skip_hint", SKIP_HINT)
