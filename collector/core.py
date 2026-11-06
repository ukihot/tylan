"""Pure parsers and audit decisions: no subprocess, filesystem, clock or network."""

from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import json
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

MAX_INPUT = 10 * 1024 * 1024
JST = timezone(timedelta(hours=9))


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


@dataclass(frozen=True)
class Evaluation:
    status: str
    reason: str
    nextCheck: str = "管理設定・承認基準・別の観測点で確認してください"

    def to_dict(self):
        return asdict(self)


def observation(kind, source, segment, when, value):
    return {
        "id": digest([kind, source, segment, when, value])[:32],
        "type": kind,
        "source": source,
        "segment": segment,
        "observedAt": when,
        "value": value,
    }


def bounded_text(value):
    if len(value.encode("utf-8")) > MAX_INPUT:
        raise ValueError("input exceeds 10MiB")
    return value


def normalize_nmap(xml, segment, when):
    bounded_text(xml)
    upper = xml.upper()
    if "<!ENTITY" in upper or " SYSTEM " in upper or " PUBLIC " in upper or "<![" in upper:
        raise ValueError("DTD entities are prohibited")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError("incomplete or invalid Nmap XML") from exc
    if root.tag != "nmaprun":
        raise ValueError("expected Nmap XML")
    result = []
    for host in root.findall("host"):
        status = host.find("status")
        addresses = [a.get("addr") for a in host.findall("address") if a.get("addrtype") == "ipv4"]
        mac = next(
            (
                a.get("addr", "").lower()
                for a in host.findall("address")
                if a.get("addrtype") == "mac"
            ),
            None,
        )
        ports = []
        for port in host.findall("ports/port"):
            state = port.find("state")
            number = int(port.get("portid", "0"))
            if not 1 <= number <= 65535 or state is None:
                raise ValueError("invalid port record")
            ports.append(
                {
                    "protocol": port.get("protocol"),
                    "port": number,
                    "state": state.get("state"),
                    "reason": state.get("reason"),
                }
            )
        for address in addresses:
            ipaddress.IPv4Address(address)
            result.append(
                observation(
                    "device",
                    "nmap",
                    segment,
                    when,
                    {
                        "ip": address,
                        "mac": mac,
                        "ports": ports,
                        "state": status.get("state") if status is not None else "unknown",
                        "reason": status.get("reason") if status is not None else None,
                        "hostname": next(
                            (n.get("name", "")[:100] for n in host.findall("hostnames/hostname")),
                            None,
                        ),
                    },
                )
            )
    if len(result) > 100000:
        raise ValueError("too many observations")
    return result


TSHARK_FIELDS = [
    "frame.time_epoch",
    "ip.src",
    "ip.dst",
    "arp.src.proto_ipv4",
    "arp.src.hw_mac",
    "dns.flags.response",
    "dns.flags.rcode",
    "dns.id",
    "dns.qry.name",
    "udp.srcport",
    "udp.dstport",
    "dhcp.option.dhcp",
    "dhcp.option.dhcp_server_id",
    "dhcp.ip.relay",
    "dhcp.ip.your",
    "dhcp.option.router",
    "dhcp.option.domain_name_server",
    "dhcp.option.ip_address_lease_time",
    "eth.src",
]


def normalize_tshark(tsv, segment):
    bounded_text(tsv)
    reader = csv.DictReader(io.StringIO(tsv), delimiter="\t", quotechar='"')
    if not reader.fieldnames or any(f not in TSHARK_FIELDS for f in reader.fieldnames):
        raise ValueError("unsupported TShark fields")
    result = []
    for row_index, row in enumerate(reader):
        if None in row or any(v is None for v in row.values()):
            raise ValueError("incomplete field record")

        def get(key, fields=row):
            return (fields.get(key) or "").split(",")[0]

        first_index = len(result)
        try:
            when = datetime.fromtimestamp(float(get("frame.time_epoch")), JST).isoformat(
                timespec="seconds"
            )
        except (ValueError, OverflowError, OSError) as exc:
            raise ValueError("invalid packet timestamp") from exc
        ip = get("ip.src")
        arp_ip = get("arp.src.proto_ipv4")
        if arp_ip and arp_ip != "0.0.0.0":
            ipaddress.IPv4Address(arp_ip)
            result.append(
                observation(
                    "arp",
                    "tshark",
                    segment,
                    when,
                    {"ip": arp_ip, "mac": get("arp.src.hw_mac").lower()},
                )
            )
        if ip:
            ipaddress.IPv4Address(ip)
            if get("dhcp.option.dhcp") in ("2", "5"):
                result.append(
                    observation(
                        "dhcp",
                        "tshark",
                        segment,
                        when,
                        {
                            "server": get("dhcp.option.dhcp_server_id") or ip,
                            "ip": ip,
                            "relay": get("dhcp.ip.relay") or None,
                            "message": get("dhcp.option.dhcp"),
                            "mac": get("eth.src").lower() or None,
                        "offeredAddress": get('dhcp.ip.your') or None,
                        "gateway": get('dhcp.option.router') or None,
                        "dns": (row.get('dhcp.option.domain_name_server') or '').split(',') if row.get('dhcp.option.domain_name_server') else [],
                        "leaseSeconds": int(get('dhcp.option.ip_address_lease_time')) if get('dhcp.option.ip_address_lease_time').isdigit() else None,
                        },
                    )
                )
            if get("dns.flags.response"):
                result.append(
                    observation(
                        "dns",
                        "tshark",
                        segment,
                        when,
                        {
                            "ip": ip,
                            "destination": get("ip.dst"),
                            "response": get("dns.flags.response") == "1",
                            "rcode": get("dns.flags.rcode") or None,
                            "transaction": get("dns.id"),
                            "questionHash": digest(get("dns.qry.name")),
                        },
                    )
                )
        if len(result) > 100000:
            raise ValueError("observation limit reached")
        for item in result[first_index:]:
            item["id"] = digest([item["id"], get("frame.time_epoch"), row_index])[:32]
    return result


def capture_filter(arp=True, dns=True, dhcp=True):
    inner = []
    if dns:
        inner.append("port 53")
    if dhcp:
        inner.append("(udp and (port 67 or port 68))")
    parts = ["arp"] if arp else []
    if inner:
        parts.append(
            "(ip and (" + " or ".join(inner) + "))"
            if arp
            else "ip and (" + " or ".join(inner) + ")"
        )
    return " or ".join(parts) or None


def authorize_targets(profile, routes):
    source = ipaddress.IPv4Address(profile["source"])
    local = ipaddress.IPv4Network(f"{source}/{profile['prefixLength']}", strict=False)
    mode = profile.get("mode", "standard")
    if mode not in ("standard", "detail", "passive"):
        raise ValueError("unknown mode")
    targets = set()
    for cidr in profile["cidrs"]:
        network = ipaddress.IPv4Network(cidr, strict=True)
        if network.num_addresses > 65536:
            raise ValueError("range too large")
        if mode == "standard" and not network.subnet_of(local):
            raise ValueError("target outside on-link subnet")
        targets.update(network.hosts())
    excludes = [ipaddress.IPv4Network(e, strict=False) for e in profile.get("exclude", [])]
    targets = {ip for ip in targets if ip != source and not any(ip in e for e in excludes)}
    if len(targets) > (256 if mode == "standard" else 4096):
        raise ValueError("target limit exceeded")
    for ip in targets:
        if ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_link_local:
            raise ValueError("invalid destination")
        candidates = [r for r in routes if ip in ipaddress.IPv4Network(r["prefix"], strict=False)]
        if not candidates:
            raise ValueError("route missing")
        best_prefix = max(
            ipaddress.IPv4Network(r["prefix"], strict=False).prefixlen for r in candidates
        )
        candidates = [
            r
            for r in candidates
            if ipaddress.IPv4Network(r["prefix"], strict=False).prefixlen == best_prefix
        ]
        metric = min(r["metric"] for r in candidates)
        best = {json.dumps(r, sort_keys=True) for r in candidates if r["metric"] == metric}
        if len(best) != 1:
            raise ValueError("ambiguous route")
        selected = json.loads(next(iter(best)))
        if selected["ifIndex"] != profile["ifIndex"] or (
            mode == "standard" and selected["nextHop"] != "0.0.0.0"
        ):
            raise ValueError("route violates selected interface/on-link scope")
    return sorted(map(str, targets), key=ipaddress.IPv4Address)


def evaluate_dhcp(observed_responses, capture_succeeded, approved=None):
    if not capture_succeeded:
        return Evaluation("inconclusive", "DHCP観測失敗または未実施")
    if not observed_responses:
        return Evaluation("inconclusive", "DHCP応答未観測。不在の証明ではありません")
    if approved is None:
        return Evaluation("inconclusive", "承認DHCP基準未設定")
    unexpected = sorted({r["server"] for r in observed_responses} - set(approved))
    if unexpected:
        return Evaluation("finding", "承認基準にないDHCP配布元候補: " + ", ".join(unexpected))
    return Evaluation("noFindingInScope", "観測した配布元は基準内。未観測の配布元は評価できません")


def evaluate_ipv6(addresses, routes, succeeded, unused=True):
    if not succeeded:
        return Evaluation("inconclusive", "IPv6設定未確認")
    defaults = [r for r in routes if r.get("prefix") == "::/0"]
    global_addresses = [
        a
        for a in addresses
        if not ipaddress.IPv6Address(a["address"]).is_link_local and a["address"] != "::1"
    ]
    if unused and (defaults or global_addresses):
        return Evaluation(
            "finding",
            "運用基準はIPv6未使用ですがアドレス/既定経路があります。管理者へ確認してください",
        )
    return Evaluation(
        "noFindingInScope", "取得時点の自ホスト設定を確認。LAN全体の通信/経路不在は保証しません"
    )


def same_device_candidates(values):
    return [{**value, "certainty": "candidate"} for value in values]


def evaluate_dns(packets, expected=None, configured=None):
    configured = configured or []
    if expected is None:
        return Evaluation('inconclusive', '想定DNS基準未設定。観測統計だけを表示します')
    destinations = {p.get('destination') for p in packets if not p.get('response') and p.get('destination')}
    unexpected = sorted((set(configured) | destinations) - set(expected))
    if unexpected:
        return Evaluation('finding', '想定外DNS設定/宛先候補: ' + ', '.join(unexpected))
    if not configured and not packets:
        return Evaluation('inconclusive', 'DNS設定/通信を確認できません')
    codes = {}
    for packet in packets:
        if packet.get('response'):
            code = packet.get('rcode') or 'unknown'
            codes[code] = codes.get(code, 0) + 1
    return Evaluation('noFindingInScope', f'取得したDNS設定/宛先は基準内。観測応答コード件数 {codes}。単発NXDOMAINや無応答から障害を断定しません')


def findings_for(observations, capture_succeeded, approved=None):
    finding = evaluate_dhcp(
        [o["value"] for o in observations if o["type"] == "dhcp"], capture_succeeded, approved
    )
    findings = [
        {
            "id": "dhcp-server-v1",
            "itemNo": 14,
            **finding.to_dict(),
            "observationIds": [o["id"] for o in observations if o["type"] == "dhcp"],
        }
    ]
    arp = {}
    for obs in observations:
        if obs["type"] == "arp":
            arp.setdefault((obs["segment"], obs["value"]["ip"]), set()).add(obs["value"]["mac"])
    for (segment, ip), macs in arp.items():
        if len(macs) > 1:
            findings.append(
                {
                    "id": digest([segment, ip, sorted(macs)])[:32],
                    "itemNo": 16,
                    "status": "finding",
                    "reason": f"{ip}に複数MAC。IP再利用・冗長GW・proxy ARPを確認",
                    "nextCheck": "管理設定と時系列を確認",
                    "observationIds": [],
                }
            )
    return findings
