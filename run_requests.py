#!/usr/bin/env python3
"""Fire all QA requests at a running valhalla_service and collect the responses in a zip.

Requests live in ``requests/<action>/<costing>/<name>.json`` and look like
``{"request": {...}}``. Each one is POSTed to ``<valhalla-url>/<action>``.

The output zip contains ``responses/<action>_<costing>_<name>.json`` per request,
each holding ``{"action": ..., "costing": ..., "status_code": <int|null>, "response": <body>}``. Non-JSON bodies
(e.g. GPX) are stored as a string. Transport failures (timeouts, connection errors)
are recorded under ``"error"`` and make the script exit non-zero.

Only the standard library is used so it runs in CI without extra dependencies.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DEFAULT_REQUESTS_DIR = Path(__file__).resolve().parent / "requests"


def collect_requests(requests_dir: Path) -> list[tuple[str, Path]]:
    """Return (output name, path) pairs for all request files, sorted by output name."""
    found = {}
    for path in requests_dir.rglob("*.json"):
        rel = path.relative_to(requests_dir)
        if len(rel.parts) != 3:
            sys.exit(f"unexpected request location {rel}, expected <action>/<costing>/<name>.json")
        action, costing, _ = rel.parts
        out_name = f"{action}_{costing}_{path.stem}.json"
        if out_name in found:
            sys.exit(f"duplicate output name {out_name} for {rel} and {found[out_name]}")
        found[out_name] = path
    return sorted(found.items())


def fire(base_url: str, path: Path, timeout: float) -> dict:
    action, costing = path.parent.parent.name, path.parent.name
    meta = {"action": action, "costing": costing}
    with path.open() as f:
        body = json.load(f)["request"]

    req = urllib.request.Request(
        f"{base_url}/{action}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        # valhalla answers bad requests with a JSON error body, which is a valid QA result
        status, raw = e.code, e.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        return {**meta, "status_code": None, "response": None, "error": str(getattr(e, "reason", e))}

    try:
        payload = json.loads(raw)
    except ValueError:
        payload = raw.decode("utf-8", errors="replace")
    return {**meta, "status_code": status, "response": payload}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--valhalla-url", required=True, help="base URL of valhalla_service, e.g. http://localhost:8002")
    parser.add_argument("-j", "--concurrency", type=int, default=4, help="number of parallel requests (default: 4)")
    parser.add_argument("-o", "--output", required=True, type=Path, help="output zip file")
    parser.add_argument("--requests-dir", type=Path, default=DEFAULT_REQUESTS_DIR, help="directory holding the request jsons")
    parser.add_argument("--timeout", type=float, default=60, help="per-request timeout in seconds (default: 60)")
    args = parser.parse_args()

    if args.concurrency < 1:
        parser.error("--concurrency must be >= 1")

    base_url = args.valhalla_url.rstrip("/")
    requests = collect_requests(args.requests_dir)
    if not requests:
        sys.exit(f"no requests found in {args.requests_dir}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(f"firing {len(requests)} requests at {base_url} with concurrency {args.concurrency}", file=sys.stderr)

    failures = []
    start = time.monotonic()
    with (
        zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED) as zf,
        ThreadPoolExecutor(max_workers=args.concurrency) as pool,
    ):
        futures = {pool.submit(fire, base_url, path, args.timeout): name for name, path in requests}
        for i, future in enumerate(as_completed(futures), 1):
            name = futures[future]
            result = future.result()
            if "error" in result:
                failures.append(name)
                print(f"[{i}/{len(requests)}] {name}: ERROR {result['error']}", file=sys.stderr)
            else:
                print(f"[{i}/{len(requests)}] {name}: {result['status_code']}", file=sys.stderr)
            zf.writestr(f"responses/{name}", json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    print(f"done in {time.monotonic() - start:.1f}s, wrote {args.output}", file=sys.stderr)
    if failures:
        print(f"{len(failures)} request(s) failed to get a response: {', '.join(sorted(failures))}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
