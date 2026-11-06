"""Fixed collection recipes. Live sending is only possible after scope validation."""

from __future__ import annotations

import ipaddress
import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path

from .core import (
    JST,
    TSHARK_FIELDS,
    authorize_targets,
    capture_filter,
    digest,
    evaluate_ipv6,
    findings_for,
    normalize_nmap,
    normalize_tshark,
    observation,
)
from .evidence import sha_file
from .management import validate_management
from .route_watcher import RouteWatcher
from .windows_process import WindowsRun

FEATURES = {"arp", "dns", "dhcp", "ipv6Local", "discovery", "ports"}
DEFAULT_PORTS = [22, 53, 80, 135, 139, 443, 445, 515, 631, 3389, 5985, 5986, 8080, 8443, 9100]
PROFILE_KEYS = {
    "mode",
    "features",
    "cidrs",
    "exclude",
    "source",
    "prefixLength",
    "ifIndex",
    "nicGuid",
    "duration",
    "ports",
    "approvedDhcp",
    "expectedDns",
    "siteId",
    "roundId",
    "documentId",
    "executionPlanHash",
    "approvedPlanHash",
    "management",
    "serviceDetection",
}


def validate_profile(value):
    if not isinstance(value, dict) or set(value) - PROFILE_KEYS:
        raise ValueError("unknown profile fields")
    profile = {
        "mode": "standard",
        "duration": 300,
        "ports": DEFAULT_PORTS,
        "cidrs": [],
        "exclude": [],
        "features": {key: True for key in FEATURES},
        **value,
    }
    if profile["mode"] not in ("standard", "passive", "detail"):
        raise ValueError("unknown mode")
    if not isinstance(profile["features"], dict) or set(profile["features"]) - FEATURES:
        raise ValueError("unknown feature")
    profile["features"] = {key: profile["features"].get(key, False) for key in FEATURES}
    if any(type(v) is not bool for v in profile["features"].values()):
        raise ValueError("invalid feature flags")
    if type(profile["duration"]) is not int or not 5 <= profile["duration"] <= 1800:
        raise ValueError("invalid observation duration")
    if (
        not isinstance(profile["ports"], list)
        or len(profile["ports"]) > (20 if profile["mode"] == "standard" else 64)
        or any(type(p) is not int or not 1 <= p <= 65535 for p in profile["ports"])
    ):
        raise ValueError("invalid TCP ports")
    for key in ("cidrs", "exclude"):
        if not isinstance(profile[key], list) or len(profile[key]) > 256:
            raise ValueError("invalid ranges")
        for network in profile[key]:
            ipaddress.IPv4Network(network, strict=False)
    if profile["mode"] != "passive":
        ipaddress.IPv4Address(profile["source"])
        if (
            type(profile.get("ifIndex")) is not int
            or profile["ifIndex"] < 1
            or not profile["cidrs"]
        ):
            raise ValueError("select NIC and IPv4 scope")
    for key in ("approvedDhcp", "expectedDns"):
        if key in profile and profile[key] is not None:
            if not isinstance(profile[key], list) or len(profile[key]) > 100:
                raise ValueError("invalid baseline")
            for address in profile[key]:
                ipaddress.IPv4Address(address)
    if profile.get("management") and profile["mode"] != "detail":
        raise ValueError("remote management requires detail approval")
    if profile.get('management'):
        validate_management(profile['management'])
    if 'serviceDetection' in profile and (type(profile['serviceDetection']) is not bool or (profile['serviceDetection'] and profile['mode'] != 'detail')):
        raise ValueError('service detection requires detailed approval')
    return profile


def nmap_interface(output, source, mac):
    matches = []
    for line in output.splitlines():
        words = line.split()
        if (
            len(words) >= 7
            and words[2].split("/")[0] == source
            and words[3] == "ethernet"
            and words[4] == "up"
            and words[6].lower().replace("-", ":") == mac.lower().replace("-", ":")
        ):
            matches.append(words[0])
    if len(matches) != 1:
        raise ValueError("Nmap interface/address/MAC mapping is not unique")
    return matches[0]


def tool_paths():
    result = {"powershell": shutil.which("powershell.exe")}
    for name, folder in (("nmap", "Nmap"), ("tshark", "Wireshark")):
        candidates = [
            Path(os.environ.get(key, "C:/Program Files")) / folder / f"{name}.exe"
            for key in ("ProgramFiles", "ProgramFiles(x86)")
        ]
        result[name] = next(
            (str(p.resolve()) for p in candidates if p.is_file()), shutil.which(f"{name}.exe")
        )
    return result


def execution_plan(value, inventory):
    profile = validate_profile(value)
    adapters = [a for a in inventory["adapters"] if a["ifIndex"] == profile.get("ifIndex")]
    if len(adapters) != 1 or adapters[0]["guid"].lower() != profile.get("nicGuid", "").lower():
        raise ValueError("NIC identity changed")
    adapter = adapters[0]
    if profile["mode"] != "passive":
        assigned = [
            a
            for a in inventory["addresses"]
            if a["family"] == "IPv4"
            and a["ifIndex"] == profile["ifIndex"]
            and a["address"] == profile["source"]
            and a["prefixLength"] == profile["prefixLength"]
            and a["state"] == "Preferred"
            and not a.get("skipAsSource", False)
        ]
        if len(assigned) != 1:
            raise ValueError("source IPv4 is not assigned/preferred on selected NIC")
    routes = sorted(
        [
            {k: r[k] for k in ("prefix", "ifIndex", "nextHop", "metric")}
            for r in inventory["routes"]
            if r["family"] == "IPv4"
        ],
        key=digest,
    )
    targets = authorize_targets(profile, routes) if profile["mode"] != "passive" else []
    if profile["mode"] == "standard" and not adapter["hardware"]:
        raise ValueError("standard mode requires physical Ethernet NIC")
    options = {
        key: profile[key]
        for key in sorted(profile)
        if key not in ("executionPlanHash", "approvedPlanHash")
    }
    management = validate_management(profile.get('management', {}))
    if management['targets']:
        authorized = authorize_targets({**profile, 'cidrs': [ip + '/32' for ip in management['targets']]}, routes)
        if authorized != management['targets']:
            raise ValueError('management target is excluded or is the local host')
    plan = {
        "targets": targets,
        "routes": routes,
        "source": profile.get("source"),
        "nic": adapter,
        "ports": profile["ports"],
        "mode": profile["mode"],
        "options": options,
        'managementTargets': management['targets'],
    }
    return {**plan, "hash": digest(plan)}


class Collector:
    def __init__(self, run_root):
        self.root = Path(run_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.sequence = 0

    def __call__(self, value, cancelled, emit):
        profile = validate_profile(value)
        started = datetime.now(JST).isoformat(timespec="seconds")
        deadline = time.monotonic() + (1920 if profile["mode"] == "passive" else 900)
        observations, collectors, tools = [], [], {}
        paths = tool_paths()

        def command(job, args, name, timeout=30, changed=None):
            if cancelled.is_set() or (changed and changed.is_set()) or time.monotonic() >= deadline:
                raise TimeoutError("cancelled/route changed before process start")
            self.sequence += 1
            stdout = self.root / f"{self.sequence}-{name}.out"
            stderr = self.root / f"{self.sequence}-{name}.err"
            handle = job.spawn(args, stdout, stderr)
            end = min(deadline, time.monotonic() + timeout)
            while job.poll(handle) is None:
                if cancelled.is_set() or (changed and changed.is_set()) or time.monotonic() >= end:
                    job.stop()
                    raise TimeoutError("cancelled/route changed/time limit")
                if stdout.stat().st_size + stderr.stat().st_size > 10 * 1024 * 1024:
                    job.stop()
                    raise ValueError("tool output exceeds limit")
                time.sleep(0.05)
            code = job.poll(handle)
            if code:
                raise ValueError(
                    f"{name} failed ({code}): "
                    + stderr.read_text(encoding="utf-8", errors="replace")[:500]
                )
            return stdout.read_text(encoding="utf-8-sig", errors="strict")

        with WindowsRun() as job:
            for name, path in paths.items():
                if path:
                    try:
                        version = command(
                            job,
                            [path, "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]
                            if name == "powershell"
                            else [path, "--version"],
                            f"{name}-version",
                        )
                        tools[name] = {
                            "path": path,
                            "version": version[:1000],
                            "sha256": sha_file(path),
                        }
                    except Exception as exc:
                        collectors.append(
                            {"name": name + "-diagnostic", "state": "failed", "reason": str(exc)}
                        )
            if not paths["powershell"]:
                raise ValueError("Windows PowerShell unavailable")

            def local(targets=None):
                output = self.root / f"local-{self.sequence}.json"
                args = [
                    paths["powershell"],
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(Path(__file__).with_name("collect-host.ps1")),
                    "-Output",
                    str(output),
                ]
                if profile['features']['ipv6Local']:
                    args += ['-IncludeIPv6']
                if targets:
                    ip_file = self.root / "route-targets.txt"
                    ip_file.write_text("\n".join(targets), encoding="utf-8")
                    args += ["-Targets", str(ip_file)]
                command(job, args, "local")
                if output.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError("local output too large")
                return json.loads(output.read_text(encoding="utf-8-sig"))

            emit("validating")
            inventory = local()
            observations.append(
                observation(
                    "hostConfiguration",
                    "powershell",
                    profile.get("siteId", "local"),
                    started,
                    {
                        "adapters": inventory["adapters"],
                        "addresses": [a for a in inventory["addresses"] if a["family"] == "IPv4"],
                        "routes": [r for r in inventory["routes"] if r["family"] == "IPv4"],
                        "dns": inventory["dns"],
                        "dhcp": inventory["dhcp"],
                        "computer": inventory["computer"],
                    },
                )
            )
            collectors.append({"name": "local", "state": "completed", "reason": None})
            if profile["features"]["ipv6Local"]:
                ipv6_addresses = [a for a in inventory["addresses"] if a["family"] == "IPv6"]
                ipv6_routes = [
                    r
                    for r in inventory["routes"]
                    if r["family"] == "IPv6" and r["prefix"] == "::/0"
                ]
                observations.append(
                    observation(
                        "ipv6Configuration",
                        "powershell",
                        "host",
                        started,
                        {"addresses": ipv6_addresses, "routes": ipv6_routes},
                    )
                )
            plan = execution_plan(profile, inventory)
            adapter, routes, targets, plan_hash = (
                plan["nic"],
                plan["routes"],
                plan["targets"],
                plan["hash"],
            )
            if profile["mode"] == "detail" and profile.get("approvedPlanHash") != plan_hash:
                raise ValueError("detail route approval expired or absent; planHash=" + plan_hash)
            capture = None
            capture_output = self.root / "capture.tsv"
            capture_error = self.root / "capture.err"
            tshark_filter = capture_filter(
                profile["features"]["arp"], profile["features"]["dns"], profile["features"]["dhcp"]
            )
            capture_started = None
            if paths["tshark"] and tshark_filter:
                try:
                    fields = command(job, [paths["tshark"], "-G", "fields"], "fields", 60)
                    if any("\t" + field + "\t" not in fields for field in TSHARK_FIELDS):
                        raise ValueError("unsupported TShark field version")
                    interfaces = command(job, [paths["tshark"], "-D"], "capture-interfaces")
                    guid = adapter["guid"].strip("{}").lower()
                    matches = [
                        line.split(". ", 1)[0]
                        for line in interfaces.splitlines()
                        if guid in line.lower()
                    ]
                    if len(matches) != 1:
                        raise ValueError("capture NIC mapping not unique")
                    args = [
                        paths["tshark"],
                        "-n",
                        "-i",
                        matches[0],
                        "-a",
                        f"duration:{profile['duration']}",
                        "-f",
                        tshark_filter,
                        "-T",
                        "fields",
                        "-E",
                        "header=y",
                        "-E",
                        "separator=/t",
                        "-E",
                        "quote=d",
                        "-E",
                        "occurrence=a",
                    ]
                    for field in TSHARK_FIELDS:
                        args += ["-e", field]
                    capture = job.spawn(args, capture_output, capture_error)
                    capture_started = time.monotonic()
                except Exception as exc:
                    collectors.append({"name": "capture", "state": "failed", "reason": str(exc)})
            else:
                collectors.append(
                    {"name": "capture", "state": "skipped", "reason": "機能OFFまたはTShark未導入"}
                )
            emit("observing")
            passive_until = min(deadline, time.monotonic() + (30 if capture else 0))
            while time.monotonic() < passive_until and not cancelled.wait(0.1):
                if capture and job.poll(capture) is not None:
                    break
            if targets and (profile["features"]["discovery"] or profile["features"]["ports"]):
                try:
                    if not paths["nmap"]:
                        raise ValueError("Nmap unavailable")
                    listing = command(job, [paths["nmap"], "--iflist"], "nmap-iflist")
                    nic = nmap_interface(listing, profile["source"], adapter["mac"])
                    with RouteWatcher() as watcher:
                        emit("scanning")
                        for start in range(0, len(targets), 16):
                            if cancelled.is_set() or watcher.changed.is_set():
                                raise TimeoutError("cancelled/route changed")
                            batch = targets[start : start + 16]
                            current = local(batch)
                            current_routes = [
                                {k: r[k] for k in ("prefix", "ifIndex", "nextHop", "metric")}
                                for r in current["routes"]
                                if r["family"] == "IPv4"
                            ]
                            if digest(sorted(current_routes, key=digest)) != digest(
                                sorted(routes, key=digest)
                            ):
                                raise ValueError("route snapshot changed")
                            for chosen in current["bestRoutes"]:
                                if (
                                    chosen["ifIndex"] != profile["ifIndex"]
                                    or chosen["source"] != profile["source"]
                                    or (
                                        profile["mode"] == "standard"
                                        and chosen["nextHop"] != "0.0.0.0"
                                    )
                                ):
                                    raise ValueError("OS best route violates approved path")
                            authorize_targets(profile, current_routes)
                            for phase in ("discovery", "ports"):
                                if not profile["features"][phase]:
                                    continue
                                output = self.root / f"nmap-{start}-{phase}.xml"
                                args = [
                                    paths["nmap"],
                                    "-n",
                                    "-e",
                                    nic,
                                    "-S",
                                    profile["source"],
                                    "--send-eth",
                                    "--max-rate",
                                    "50",
                                    "--max-retries",
                                    "1",
                                    "--host-timeout",
                                    "10s",
                                    "-oX",
                                    str(output),
                                ]
                                args += (
                                    ["-sn", "-PR"]
                                    if phase == "discovery"
                                    else [
                                        "-sS",
                                        "-Pn",
                                        "--max-parallelism",
                                        "4",
                                        "--scan-delay",
                                        "100ms",
                                        "-p",
                                        ",".join(map(str, profile["ports"])),
                                    ]
                                )
                                if profile['mode'] == 'detail' and profile.get('serviceDetection') and phase == 'ports':
                                    args += ['-sV', '--version-light']
                                command(job, args + batch, "nmap", 10, watcher.changed)
                                observations.extend(
                                    normalize_nmap(
                                        output.read_text(encoding="utf-8"),
                                        profile.get("siteId", "local"),
                                        datetime.now(JST).isoformat(timespec="seconds"),
                                    )
                                )
                    collectors.append(
                        {
                            "name": "nmap",
                            "state": "completed",
                            "reason": None,
                            "targets": len(targets),
                        }
                    )
                except Exception as exc:
                    collectors.append(
                        {
                            "name": "nmap",
                            "state": "cancelled" if cancelled.is_set() else "failed",
                            "reason": str(exc),
                        }
                    )
            else:
                collectors.append({"name": "nmap", "state": "skipped", "reason": "能動収集OFF"})
            if capture:
                while (
                    job.poll(capture) is None
                    and not cancelled.is_set()
                    and time.monotonic() < deadline
                ):
                    if (
                        capture_output.stat().st_size + capture_error.stat().st_size
                        > 10 * 1024 * 1024
                    ):
                        break
                    time.sleep(0.1)
                success = job.poll(capture) == 0
                if not success:
                    job.stop()
                try:
                    observations.extend(
                        normalize_tshark(
                            capture_output.read_text(encoding="utf-8"),
                            profile.get("siteId", "local"),
                        )
                    )
                    collectors.append(
                        {
                            "name": "capture",
                            "state": "completed" if success else "timedOut",
                            "reason": None if success else "観測途中終了",
                            "seconds": round(time.monotonic() - capture_started, 1),
                            "dropped": None,
                        }
                    )
                except Exception as exc:
                    collectors.append({"name": "capture", "state": "failed", "reason": str(exc)})
                # Raw question names were transient extraction data, never evidence.
                capture_output.unlink(missing_ok=True)
            if profile.get('management'):
                management = validate_management(profile['management'])
                requests = []
                if management.get('ad'):
                    requests.append({'kind': 'ad', **management['ad']})
                requests += [{'kind': 'dhcp', 'server': address} for address in management.get('dhcpServers', [])]
                requests += [{'kind': 'windows', 'server': address} for address in management.get('windows', [])]
                emit('management')
                with RouteWatcher() as watcher:
                    for request in requests:
                        try:
                            current = local([request['server']])
                            if execution_plan(profile, current)['hash'] != plan_hash or watcher.changed.is_set():
                                raise ValueError('management route approval changed')
                            if len(current['bestRoutes']) != 1 or current['bestRoutes'][0]['source'] != profile['source'] or current['bestRoutes'][0]['ifIndex'] != profile['ifIndex']:
                                raise ValueError('management OS path mismatch')
                            input_path = self.root / ('management-' + digest(request) + '.json')
                            output_path = self.root / ('management-' + digest(request) + '-result.json')
                            input_path.write_text(json.dumps(request), encoding='utf-8')
                            command(job, [paths['powershell'], '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(Path(__file__).with_name('collect-management.ps1')), '-InputFile', str(input_path), '-Output', str(output_path)], 'management', 60, watcher.changed)
                            if output_path.stat().st_size > 10 * 1024 * 1024:
                                raise ValueError('management result too large')
                            data = json.loads(output_path.read_text(encoding='utf-8-sig'))
                            collectors.append({'name': 'management-' + request['kind'] + '-' + request['server'], 'state': data['state'], 'reason': data['reason']})
                            kind = {'ad': 'adComputer', 'dhcp': 'dhcpScope', 'windows': 'hostConfiguration'}[request['kind']]
                            for record in data['records']:
                                when = datetime.now(JST).isoformat(timespec='seconds')
                                observations.append(observation(kind, 'powershell-management', profile.get('siteId', 'local'), when, record))
                                if request['kind'] == 'windows':
                                    for address in record['addresses']:
                                        if ipaddress.ip_address(address).version == 4:
                                            observations.append(observation('device', 'powershell-management', profile.get('siteId', 'local'), when, {'ip': address, 'mac': record['mac'].lower() if record['mac'] else None, 'hostname': record['server'], 'ports': [], 'assignmentMode': 'dhcp' if record['dhcpEnabled'] else 'static'}))
                        except Exception as exc:
                            collectors.append({'name': 'management-' + request['kind'], 'state': 'failed', 'reason': str(exc)})
                            if watcher.changed.is_set() or cancelled.is_set():
                                break
            capture_succeeded = any(
                c["name"] == "capture" and c["state"] == "completed" for c in collectors
            )
            findings = findings_for(observations, capture_succeeded, profile.get("approvedDhcp"))
            if profile["features"]["ipv6Local"]:
                evaluation = evaluate_ipv6(ipv6_addresses, ipv6_routes, True)
                findings.append(
                    {
                        "id": "ipv6-local-v1",
                        "itemNo": 12,
                        **evaluation.to_dict(),
                        "observationIds": [
                            o["id"] for o in observations if o["type"] == "ipv6Configuration"
                        ],
                    }
                )
            emit("finalizing")
            return {
                "format": "tylan-collection",
                "schemaVersion": 1,
                "profile": profile,
                "tools": tools,
                "startedAt": started,
                "endedAt": datetime.now(JST).isoformat(timespec="seconds"),
                "scope": {
                    "executionPlanHash": plan_hash,
                    "targets": targets,
                    "captureFilter": tshark_filter,
                    "observationPoint": "host",
                    "ipv6Capture": False,
                    "ipv6Scan": False,
                },
                "collectors": collectors,
                "observations": observations,
                "findings": findings,
            }
