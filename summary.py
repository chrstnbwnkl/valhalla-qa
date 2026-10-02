#!/usr/bin/env python3
"""Compare two runs of run_requests.py and bundle them with a summary.json.

Each run may be given as the zip written by run_requests.py or as an unpacked
directory. The output directory receives ``<name-a>.zip``, ``<name-b>.zip`` and
``summary.json``.

Every response pair is classified as identical, different, or present in only one
run. Different responses get a list of differing JSON paths and, for actions with
a dedicated parser (currently only ``route`` in valhalla and osrm format), a
semantic comparison of distance, duration, cost, geometry and maneuvers.

summary.json also holds per-action totals under ``actions`` and an index of every
response (action, costing, status) under ``responses``.

Timings are kept apart from the comparison: ``timings`` holds per-action request
time statistics for both runs (from the ``time_ms`` of each response, transport
failures left out). With ``--build-log-a``/``--build-log-b``, the ``[TIMING]``
lines of the valhalla_build_tiles logs end up under ``build``, per stage and in
total.
"""

import argparse
import json
import re
import shutil
import statistics
import sys
import zipfile
from pathlib import Path

MAX_DIFF_PATHS = 20
MAX_TOP_CHANGES = 10

# response file keys that describe the run rather than the result, ignored when comparing
VOLATILE_KEYS = ("time_ms",)


# ---------------------------------------------------------------------------
# loading and bundling runs


def responses_dir(path: Path) -> Path:
    return path / "responses" if (path / "responses").is_dir() else path


def load_run(path: Path) -> dict[str, dict]:
    """Return {file name: parsed response file} for a run zip or directory."""
    if path.is_dir():
        return {p.name: json.loads(p.read_text()) for p in sorted(responses_dir(path).glob("*.json"))}
    with zipfile.ZipFile(path) as zf:
        return {
            Path(n).name: json.loads(zf.read(n))
            for n in sorted(zf.namelist())
            if n.startswith("responses/") and n.endswith(".json")
        }


def bundle_run(src: Path, dest: Path) -> None:
    if src.is_dir():
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(responses_dir(src).glob("*.json")):
                zf.write(p, f"responses/{p.name}")
    else:
        shutil.copyfile(src, dest)


def comparable(f: dict) -> dict:
    return {k: v for k, v in f.items() if k not in VOLATILE_KEYS}


# ---------------------------------------------------------------------------
# timings


# e.g. "2026-06-23 10:09:26.503975933 [TIMING] src/mjolnir/util.cc::build_tile_set took 96s"
TIMING_RE = re.compile(r"\[TIMING\]\s+(\S+)\s+took\s+([\d.]+)\s*(ms|s|min|h)\b")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
TIME_UNITS = {"ms": 0.001, "s": 1, "min": 60, "h": 3600}
# the stage that wraps the whole build
BUILD_TOTAL_STAGE = "build_tile_set"


def parse_build_log(path: Path) -> dict:
    """Return {stages: [{name, seconds}], total_seconds} from the [TIMING] lines of a build log."""
    stages = []
    with path.open(errors="replace") as f:
        for line in f:
            m = TIMING_RE.search(ANSI_RE.sub("", line))
            if m:
                stages.append({"name": m[1], "seconds": float(m[2]) * TIME_UNITS[m[3]]})
    total = next((s for s in reversed(stages) if s["name"].endswith(f"::{BUILD_TOTAL_STAGE}")), None)
    if total is None and stages:
        # no wrapping stage logged, fall back to the sum
        return {"stages": stages, "total_seconds": sum(s["seconds"] for s in stages)}
    return {
        "stages": [s for s in stages if s is not total],
        "total_seconds": total["seconds"] if total else None,
    }


def time_stats(times: list[float]) -> dict:
    if not times:
        return {"count": 0}
    times = sorted(times)
    return {
        "count": len(times),
        "total_ms": round(sum(times), 3),
        "mean_ms": round(statistics.fmean(times), 3),
        "median_ms": round(statistics.median(times), 3),
        "p95_ms": round(times[min(len(times) - 1, int(0.95 * len(times)))], 3),
        "min_ms": times[0],
        "max_ms": times[-1],
    }


def request_timings(run: dict[str, dict]) -> dict:
    """Per action request time statistics, responses without a time or with a transport error are skipped."""
    per_action: dict[str, list[float]] = {}
    for f in run.values():
        if "error" in f or not isinstance(f.get("time_ms"), (int, float)):
            continue
        per_action.setdefault(f.get("action"), []).append(f["time_ms"])
    return {action: time_stats(times) for action, times in sorted(per_action.items())}


# ---------------------------------------------------------------------------
# generic comparison


def diff_paths(a, b, path="$", out=None) -> list[str]:
    """Collect JSON paths at which a and b differ (stops after MAX_DIFF_PATHS + 1)."""
    out = [] if out is None else out
    if len(out) > MAX_DIFF_PATHS:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(a.keys() | b.keys()):
            if k not in a or k not in b:
                out.append(f"{path}.{k} ({'only in b' if k not in a else 'only in a'})")
            else:
                diff_paths(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path} (length {len(a)} vs {len(b)})")
        for i, (x, y) in enumerate(zip(a, b)):
            diff_paths(x, y, f"{path}[{i}]", out)
    elif a != b:
        out.append(path)
    return out


def numeric_change(a, b) -> dict:
    change = {"a": a, "b": b}
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        change["diff"] = round(b - a, 6)
        change["rel_diff"] = round((b - a) / a, 6) if a else None
    return change


# ---------------------------------------------------------------------------
# /route parsing


def parse_valhalla_trip(trip: dict) -> dict:
    summary = trip.get("summary", {})
    legs = trip.get("legs", [])
    maneuvers = [m.get("type") for leg in legs for m in leg.get("maneuvers", [])]
    return {
        "distance": summary.get("length"),
        "duration": summary.get("time"),
        "cost": summary.get("cost"),
        "legs": len(legs),
        "maneuvers": len(maneuvers),
        "maneuver_types": maneuvers,
        "geometry": [leg.get("shape") for leg in legs],
    }


def parse_osrm_route(route: dict) -> dict:
    legs = route.get("legs", [])
    steps = [
        [s.get("maneuver", {}).get("type"), s.get("maneuver", {}).get("modifier")]
        for leg in legs
        for s in leg.get("steps", [])
    ]
    return {
        "distance": route.get("distance"),
        "duration": route.get("duration"),
        "cost": route.get("weight"),
        "legs": len(legs),
        "maneuvers": len(steps),
        "maneuver_types": steps,
        "geometry": route.get("geometry"),
    }


def parse_route_response(resp) -> dict:
    """Normalize a /route response to {format, error, routes: [primary, *alternates]}."""
    if not isinstance(resp, dict):
        return {"format": "unknown", "error": "non-JSON response", "routes": []}
    if "trip" in resp or "error_code" in resp:
        if "trip" not in resp:
            return {"format": "valhalla", "error": f"{resp.get('error_code')}: {resp.get('error')}", "routes": []}
        trips = [resp["trip"]] + [alt.get("trip", {}) for alt in resp.get("alternates", [])]
        return {"format": "valhalla", "error": None, "routes": [parse_valhalla_trip(t) for t in trips]}
    if "code" in resp:
        error = None if resp["code"] == "Ok" else f"{resp['code']}: {resp.get('message')}"
        return {"format": "osrm", "error": error, "routes": [parse_osrm_route(r) for r in resp.get("routes", [])]}
    return {"format": "unknown", "error": None, "routes": []}


def compare_routes(a: dict, b: dict) -> dict:
    pa, pb = parse_route_response(a.get("response")), parse_route_response(b.get("response"))
    result = {"format": pa["format"] if pa["format"] == pb["format"] else {"a": pa["format"], "b": pb["format"]}}
    if pa["error"] or pb["error"]:
        if pa["error"] != pb["error"]:
            result["error"] = {"a": pa["error"], "b": pb["error"]}
    if len(pa["routes"]) != len(pb["routes"]):
        result["route_count"] = {"a": len(pa["routes"]), "b": len(pb["routes"])}

    routes = []
    for i, (ra, rb) in enumerate(zip(pa["routes"], pb["routes"])):
        changes = {}
        for key in ("distance", "duration", "cost"):
            if ra[key] != rb[key]:
                changes[key] = numeric_change(ra[key], rb[key])
        for key in ("legs", "maneuvers"):
            if ra[key] != rb[key]:
                changes[key] = {"a": ra[key], "b": rb[key]}
        if ra["maneuver_types"] != rb["maneuver_types"]:
            changes["maneuver_types_changed"] = True
        if ra["geometry"] != rb["geometry"]:
            changes["geometry_changed"] = True
        if changes:
            routes.append({"index": i, **changes})
    if routes:
        result["routes"] = routes
    return result


# action -> semantic comparison of two response files
COMPARATORS = {"route": compare_routes}


# ---------------------------------------------------------------------------
# summary


def compare_pair(a: dict, b: dict) -> dict:
    action = a.get("action", "")
    entry = {"action": action, "costing": a.get("costing")}
    if a.get("status_code") != b.get("status_code"):
        entry["status_code"] = {"a": a.get("status_code"), "b": b.get("status_code")}
    if "error" in a or "error" in b:
        entry["transport_error"] = {"a": a.get("error"), "b": b.get("error")}
    comparator = COMPARATORS.get(action)
    if comparator:
        entry[action] = comparator(a, b)
    paths = diff_paths(a.get("response"), b.get("response"))
    entry["differing_paths"] = paths[:MAX_DIFF_PATHS]
    if len(paths) > MAX_DIFF_PATHS:
        entry["differing_paths_truncated"] = True
    return entry


def route_stats(different: dict[str, dict], route_total: int) -> dict:
    """Aggregate the primary-route changes over all compared /route responses."""
    stats: dict = {"compared": route_total, "different": 0, "status_changed": 0, "error_changed": 0,
             "route_count_changed": 0, "geometry_changed": 0, "maneuvers_changed": 0}
    largest = {"distance": [], "duration": [], "cost": []}
    for name, entry in different.items():
        if "route" not in entry:
            continue
        stats["different"] += 1
        route = entry["route"]
        stats["status_changed"] += "status_code" in entry
        stats["error_changed"] += "error" in route
        stats["route_count_changed"] += "route_count" in route
        primary = next((r for r in route.get("routes", []) if r["index"] == 0), {})
        stats["geometry_changed"] += primary.get("geometry_changed", False)
        stats["maneuvers_changed"] += primary.get("maneuver_types_changed", False)
        for key, changes in largest.items():
            if primary.get(key, {}).get("rel_diff") is not None:
                changes.append({"name": name, **primary[key]})
    for key, changes in largest.items():
        stats[f"{key}_changed"] = len(changes)
        stats[f"largest_{key}_changes"] = sorted(changes, key=lambda c: -abs(c["rel_diff"]))[:MAX_TOP_CHANGES]
    return stats


def summarize(name_a: str, run_a: dict, name_b: str, run_b: dict, build: dict | None = None) -> dict:
    only_a = sorted(run_a.keys() - run_b.keys())
    only_b = sorted(run_b.keys() - run_a.keys())
    common = sorted(run_a.keys() & run_b.keys())

    identical, different = [], {}
    for name in common:
        if comparable(run_a[name]) == comparable(run_b[name]):
            identical.append(name)
        else:
            different[name] = compare_pair(run_a[name], run_b[name])

    # per response index and per action totals, so consumers don't have to parse file names
    responses, actions = {}, {}
    for name in sorted(run_a.keys() | run_b.keys()):
        f = run_a.get(name) or run_b[name]
        status = (
            "only_in_a" if name in only_a
            else "only_in_b" if name in only_b
            else "different" if name in different
            else "identical"
        )
        responses[name] = {"action": f.get("action"), "costing": f.get("costing"), "status": status}
        counts = actions.setdefault(
            f.get("action"), {"total": 0, "identical": 0, "different": 0, "only_in_a": 0, "only_in_b": 0}
        )
        counts["total"] += 1
        counts[status] += 1

    route_total = sum(1 for n in common if run_a[n].get("action") == "route")
    summary = {
        "a": name_a,
        "b": name_b,
        "totals": {
            "a": len(run_a),
            "b": len(run_b),
            "identical": len(identical),
            "different": len(different),
            "only_in_a": len(only_a),
            "only_in_b": len(only_b),
        },
        "actions": actions,
        "timings": {"a": request_timings(run_a), "b": request_timings(run_b)},
        "route": route_stats(different, route_total),
        "only_in_a": only_a,
        "only_in_b": only_b,
        "different": different,
        "responses": responses,
    }
    if build:
        summary["build"] = build
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_a", type=Path, help="first run (zip or directory), e.g. the baseline")
    parser.add_argument("run_b", type=Path, help="second run (zip or directory), e.g. the candidate")
    parser.add_argument("-o", "--output", required=True, type=Path, help="output directory")
    parser.add_argument("--name-a", help="name of the first run (default: its file name without extension)")
    parser.add_argument("--name-b", help="name of the second run (default: its file name without extension)")
    parser.add_argument("--build-log-a", type=Path, help="valhalla_build_tiles log of the first run, for build timings")
    parser.add_argument("--build-log-b", type=Path, help="valhalla_build_tiles log of the second run, for build timings")
    args = parser.parse_args()

    name_a = args.name_a or args.run_a.stem
    name_b = args.name_b or args.run_b.stem
    if name_a == name_b:
        parser.error(f"both runs are named {name_a!r}, use --name-a/--name-b to tell them apart")
    for path in (args.run_a, args.run_b, args.build_log_a, args.build_log_b):
        if path and not path.exists():
            parser.error(f"{path} does not exist")

    build = {run: parse_build_log(log) for run, log in (("a", args.build_log_a), ("b", args.build_log_b)) if log}
    run_a, run_b = load_run(args.run_a), load_run(args.run_b)
    summary = summarize(name_a, run_a, name_b, run_b, build)

    args.output.mkdir(parents=True, exist_ok=True)
    bundle_run(args.run_a, args.output / f"{name_a}.zip")
    bundle_run(args.run_b, args.output / f"{name_b}.zip")
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")

    t = summary["totals"]
    print(
        f"{name_a} vs {name_b}: {t['identical']} identical, {t['different']} different, "
        f"{t['only_in_a']} only in {name_a}, {t['only_in_b']} only in {name_b} -> {args.output}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
