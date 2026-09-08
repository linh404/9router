# Codex Python OAuth sidecar

`server.py` and `auto_login.py` are the original Python OAuth login core used
by the 9router dashboard. The Next.js API adapter starts this sidecar on
demand and terminates it (including worker/browser children) when the Node
process exits.

Install the runtime dependencies once in a virtual environment:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r python/codex-auto-login/requirements.txt
.venv/bin/python -m playwright install chromium
```

On Windows use `.venv\\Scripts\\python.exe`. The sidecar listens only on
`127.0.0.1:9876`; OAuth callbacks use `localhost:1455`.
