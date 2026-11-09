"""A documented, neutral LLDP/CDP/MAC-table export; no vendor CLI or credentials."""

from datetime import datetime

from .core import observation


def normalize_switch_export(value, site, when):
    if (
        not isinstance(value, dict)
        or set(value) - {"format", "schemaVersion", "vendor", "records", "observedAt"}
        or value.get("format") != "tylan-switch-export"
        or value.get("schemaVersion") != 1
    ):
        raise ValueError("unsupported switch export; use tylan-switch-export v1")
    if not isinstance(value.get("vendor"), str) or not 1 <= len(value["vendor"]) <= 100:
        raise ValueError("vendor label required")
    if not isinstance(value.get("records"), list) or not 0 < len(value["records"]) <= 10000:
        raise ValueError("export record limit")
    if value.get("observedAt"):
        parsed = datetime.fromisoformat(value["observedAt"])
        if parsed.tzinfo is None:
            raise ValueError("export observation time needs timezone")
        when = value["observedAt"]
    result = {}
    for record in value["records"]:
        if not isinstance(record, dict) or set(record) != {
            "protocol",
            "localDevice",
            "localPort",
            "remoteDevice",
            "remotePort",
        }:
            raise ValueError("unknown export field; credentials are not accepted")
        if record["protocol"] not in ("lldp", "cdp", "mac-table"):
            raise ValueError("unsupported discovery protocol")
        for name in ("localDevice", "localPort", "remoteDevice"):
            if not isinstance(record[name], str) or not 1 <= len(record[name]) <= 100:
                raise ValueError("invalid device/port label")
        if record["remotePort"] is not None and (
            not isinstance(record["remotePort"], str) or not 1 <= len(record["remotePort"]) <= 100
        ):
            raise ValueError("invalid remote port")
        item = observation(
            "physicalCandidate",
            "switch-export",
            site,
            when,
            {
                **record,
                "vendor": value["vendor"],
                "certainty": "estimated",
                "linkKind": "logical" if record["protocol"] == "mac-table" else "physical",
                "observationTimeKnown": bool(value.get("observedAt")),
            },
        )
        result[item["id"]] = item
    return list(result.values())


def offline_collection(profile, run_id, when):
    """A finalized collection from an operator-supplied export. No process or packet is involved."""
    export = profile["switchExport"]
    observations = normalize_switch_export(export, profile["siteId"], when)
    summary = {"vendor": export["vendor"], "records": len(export["records"])}
    return {
        "format": "tylan-collection",
        "schemaVersion": 1,
        "runId": run_id,
        "profile": {**profile, "switchExport": summary},
        "tools": {},
        "startedAt": when,
        "endedAt": when,
        "scope": {
            "executionPlanHash": None,
            "targets": [],
            "captureFilter": None,
            "observationPoint": "imported",
            "ipv6Capture": False,
            "ipv6Scan": False,
        },
        "collectors": [{"name": "switch-export", "state": "completed", "reason": None, **summary}],
        "observations": observations,
        "findings": [],
    }
