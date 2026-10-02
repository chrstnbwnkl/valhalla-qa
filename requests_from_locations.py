#!/usr/bin/env python3
"""Generate QA requests from random pairs of point features in a GeoJSON file.

Requests are written to ``<requests-dir>/<action>/<costing>/<NNNNN>_<origin>-<destination>.json``,
numbered after the highest existing number in that directory.
"""

import argparse
import json
import random
import re
import sys
import unicodedata
from pathlib import Path

DEFAULT_REQUESTS_DIR = Path(__file__).resolve().parent / "requests"


def load_points(path: Path, name_property: str | None) -> list[tuple[float, float, str]]:
    """Return (lon, lat, name) for every Point feature."""
    with path.open() as f:
        features = json.load(f).get("features", [])

    points = []
    for i, feature in enumerate(features):
        geom = feature.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        name = None
        if name_property:
            # dotted paths reach into nested properties, e.g. tags.name
            value = feature.get("properties") or {}
            for key in name_property.split("."):
                value = value.get(key) if isinstance(value, dict) else None
            name = value
        points.append((lon, lat, slugify(str(name)) if name else f"f{i}"))
    return points


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower() or "unnamed"


def parse_number(s: str) -> int | float:
    try:
        return int(s)
    except ValueError:
        return float(s)


def next_index(out_dir: Path) -> int:
    indices = [
        int(m.group(1))
        for p in out_dir.glob("*.json")
        if (m := re.match(r"(\d+)", p.stem))
    ]
    return max(indices, default=0) + 1


def route_request(origin, destination, costing: str) -> dict:
    return {
        "locations": [
            {"lat": round(origin[1], 6), "lon": round(origin[0], 6)},
            {"lat": round(destination[1], 6), "lon": round(destination[0], 6)},
        ],
        "costing": costing,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("file", type=Path, help="GeoJSON file with point features")
    parser.add_argument("-n", type=int, required=True, help="number of requests to create")
    parser.add_argument("--action", choices=["route"], default="route")
    parser.add_argument("--costing", required=True, help="e.g. auto, truck, bicycle")
    parser.add_argument(
        "--location-name",
        help="feature property used to name locations, dotted for nested ones (e.g. tags.name)",
    )
    parser.add_argument("--seed", type=int, help="random seed")
    parser.add_argument(
        "--fuzz-costing-parameter",
        help="costing option to set to a random value in [--fuzz-costing-min, --fuzz-costing-max]",
    )
    parser.add_argument(
        "--fuzz-costing-min",
        type=parse_number,
        help="integer bounds produce integer values",
    )
    parser.add_argument("--fuzz-costing-max", type=parse_number)
    parser.add_argument(
        "--requests-dir",
        type=Path,
        default=DEFAULT_REQUESTS_DIR,
        help="directory holding the request jsons",
    )
    args = parser.parse_args()

    if args.n < 1:
        parser.error("-n must be >= 1")
    fuzz = args.fuzz_costing_parameter
    lo, hi = args.fuzz_costing_min, args.fuzz_costing_max
    if fuzz:
        if lo is None or hi is None:
            parser.error("--fuzz-costing-parameter requires --fuzz-costing-min and --fuzz-costing-max")
        if lo > hi:
            parser.error("--fuzz-costing-min must be <= --fuzz-costing-max")

    points = load_points(args.file, args.location_name)
    if len(points) < 2:
        sys.exit(f"need at least 2 point features in {args.file}, found {len(points)}")

    rng = random.Random(args.seed)
    out_dir = args.requests_dir / args.action / args.costing
    out_dir.mkdir(parents=True, exist_ok=True)
    start = next_index(out_dir)

    for i in range(start, start + args.n):
        origin, destination = rng.sample(points, 2)
        request = route_request(origin, destination, args.costing)
        if fuzz:
            if isinstance(lo, int) and isinstance(hi, int):
                value = rng.randint(lo, hi)
            else:
                value = round(rng.uniform(lo, hi), 3)
            request["costing_options"] = {args.costing: {fuzz: value}}

        path = out_dir / f"{i:05d}_{origin[2]}-{destination[2]}.json"
        with path.open("w") as f:
            json.dump({"request": request}, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(path, file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
