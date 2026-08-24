Import("env")
import subprocess
import sys
from pathlib import Path

# Runs at script load so `pio run` enforces the gate even when the ELF is already up to date.
GATE = Path(env["PROJECT_DIR"]).parent / "tools" / "privacy-gate" / "privacy-gate.mjs"

if not GATE.exists():
    print("privacy-gate: checker missing, skipping")
else:
    try:
        result = subprocess.run(["node", str(GATE)], capture_output=True, text=True)
    except FileNotFoundError:
        # Node is a web-platform dependency; never block flashing hardware on its absence. CI enforces this gate.
        print("privacy-gate: Node.js not found, skipping.", file=sys.stderr)
    else:
        print(result.stdout)
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr)
            raise SystemExit("privacy-gate: blocking privacy finding, build stopped")
