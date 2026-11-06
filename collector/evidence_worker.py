"""Short-lived, contained evidence I/O. A stalled SMB operation can be killed by its owner."""

import argparse
import json
from pathlib import Path

from .evidence import atomic_json, seal_package, verify_package


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    if request["operation"] == "seal":
        result = {"package": seal_package(request["source"], request["destination"])}
    elif request["operation"] == "prepare":
        package = seal_package(request["source"], request["destination"])
        intent = seal_package(request["intentSource"], request["intentDestination"])
        result = {"package": package, "intent": intent}
    elif request["operation"] == "verify":
        result = {
            "package": verify_package(Path(request["package"]["path"]), request["package"]["hash"]),
            "intent": verify_package(Path(request["intent"]["path"]), request["intent"]["hash"]),
        }
    else:
        raise ValueError("unsupported evidence operation")
    atomic_json(args.result, result)


if __name__ == "__main__":
    main()
