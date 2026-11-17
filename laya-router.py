# The channel router's local model: Laya (https://huggingface.co/convaiinnovations/laya), a decision model that
# picks one of a set of choices in a single forward pass. Team Chat starts this once and keeps it running.
#
# Protocol, one JSON object per line:
#   stdin:  {"id": 1, "state": "...", "questions": {...}, "model": "multilingual"}
#   stdout: {"ready": true, "device": "mps"}                       once the checkpoints are loaded
#           {"id": 1, "answers": {...}, "routing": {...}, "ms": 41}  or {"id": 1, "error": "..."}
# No network port: only Team Chat, through this process's pipes, can ask it anything.
import json
import os
import sys
import time

out = sys.stdout
sys.stdout = sys.stderr  # library chatter (download bars, warnings) goes to stderr, never into the protocol


def send(obj):
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


try:
    import torch
    from laya import Router

    device = os.environ.get("LAYA_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
    models = [m for m in os.environ.get("LAYA_MODELS", "english,multilingual").split(",") if m]
    router = Router(device=device, max_loaded=len(models))
    router.preload(models)
    # The first call on a device compiles kernels; do it now so the first real message isn't slow.
    for m in models:
        router.predict("warm up", {"q": {"type": "choice", "instructions": "Pick one.", "criteria": {"a": "first", "b": "second"}}}, model=m)
    send({"ready": True, "device": device, "models": models})
except Exception as e:  # noqa: BLE001 - Team Chat shows this and falls back
    send({"fatal": f"{type(e).__name__}: {e}"})
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        started = time.perf_counter()
        kwargs = {k: req[k] for k in ("model", "max_len") if req.get(k)}
        res = router.predict(req["state"], req["questions"], **kwargs)
        send({"id": req.get("id"), "answers": res.get("answers"), "routing": res.get("routing"), "ms": round((time.perf_counter() - started) * 1000)})
    except Exception as e:  # noqa: BLE001
        send({"id": req.get("id"), "error": f"{type(e).__name__}: {e}"})
