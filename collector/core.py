"""Pure parsers and audit decisions: no subprocess, filesystem, clock or network."""

from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import json
import re
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


def ipv4_or_none(value):
    return None if not value or value == "0.0.0.0" else str(ipaddress.IPv4Address(value))


def clean_name(value):
    return re.sub(r"[\x00-\x1f\x7f]", "", value)[:253]


def complete_lines(text):
    """Drops a row cut off when the capture was stopped mid-write."""
    return text[: text.rfind("\n") + 1]


def normalize_tshark(tsv, segment, limit=100000, keep_names=False):
    """Returns (observations, omitted rows). Rows past `limit` are counted, never silently lost."""
    bounded_text(tsv)
    reader = csv.DictReader(io.StringIO(tsv), delimiter="\t", quotechar='"')
    if not reader.fieldnames or any(f not in TSHARK_FIELDS for f in reader.fieldnames):
        raise ValueError("unsupported TShark fields")
    result = []
    omitted = 0
    for row_index, row in enumerate(reader):
        if None in row or any(v is None for v in row.values()):
            raise ValueError("incomplete field record")
        if len(result) >= limit:
            omitted += 1
            continue

        def get(key, fields=row):
            return (fields.get(key) or "").split(",")[0]

        first_index = len(result)
        try:
            epoch = float(get("frame.time_epoch"))
            when = datetime.fromtimestamp(epoch, JST).isoformat(timespec="seconds")
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
                lease = get("dhcp.option.ip_address_lease_time")
                dns = (row.get("dhcp.option.domain_name_server") or "").split(",")
                result.append(
                    observation(
                        "dhcp",
                        "tshark",
                        segment,
                        when,
                        {
                            "server": get("dhcp.option.dhcp_server_id") or ip,
                            "ip": ip,
                            "relay": ipv4_or_none(get("dhcp.ip.relay")),
                            "message": get("dhcp.option.dhcp"),
                            "mac": get("eth.src").lower() or None,
                            "offeredAddress": ipv4_or_none(get("dhcp.ip.your")),
                            "gateway": ipv4_or_none(get("dhcp.option.router")),
                            "dns": [str(ipaddress.IPv4Address(a)) for a in dns if a],
                            "leaseSeconds": int(lease) if lease.isdigit() else None,
                        },
                    )
                )
            if get("dns.flags.response"):
                value = {
                    "ip": ip,
                    "destination": get("ip.dst"),
                    # Wireshark 4.x prints booleans as True/False, older versions as 1/0.
                    "response": get("dns.flags.response") in ("1", "True"),
                    "rcode": get("dns.flags.rcode") or None,
                    "transaction": get("dns.id"),
                    "questionHash": digest(get("dns.qry.name")),
                    "epoch": epoch,
                }
                if keep_names:
                    value["question"] = clean_name(get("dns.qry.name"))
                result.append(observation("dns", "tshark", segment, when, value))
        for item in result[first_index:]:
            item["id"] = digest([item["id"], get("frame.time_epoch"), row_index])[:32]
    return result, omitted


def capture_stats(stderr):
    """TShark's end-of-capture summary. Without it drops are unknown, never zero."""
    captured = re.search(r"^(\d+) packets? captured", stderr, re.M)
    drops = [int(n) for n in re.findall(r"^(\d+) packets? dropped", stderr, re.M)]
    return {
        "captured": int(captured[1]) if captured else None,
        "dropped": sum(drops) if drops else 0 if captured else None,
    }


def capture_outcome(code, stderr, stopped, rows, parse_error):
    if parse_error:
        state, reason = "failed", f"出力解析失敗: {parse_error}"
    elif stopped == "cancelled":
        state, reason = "cancelled", "取消により観測途中終了"
    elif stopped == "deadline":
        state, reason = "timedOut", "期限により観測途中終了"
    elif stopped == "capacity":
        state, reason = "truncated", "容量上限で観測を打ち切り。以降の通信は欠落しています"
    elif stopped == "aborted":
        state, reason = "truncated", "他の収集の停止に伴い観測途中終了。以降の通信は欠落しています"
    elif code:
        denied = re.search(r"permission|npcap|access is denied|privilege", stderr, re.I)
        prefix = "キャプチャ権限不足またはNpcap未設定" if denied else f"TShark異常終了({code})"
        state, reason = "failed", f"{prefix}: {stderr[-300:]}"
    elif rows == 0:
        state, reason = "completed", "0件（条件内の対象通信を観測せず。不在の証明ではありません）"
    else:
        state, reason = "completed", None
    return {"state": state, "reason": reason, **capture_stats(stderr)}


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


def evaluate_dhcp(
    observed_responses, capture_succeeded, approved=None, expected_gateway=None, expected_dns=None
):
    if not capture_succeeded:
        return Evaluation("inconclusive", "DHCP観測失敗または未実施")
    if not observed_responses:
        return Evaluation("inconclusive", "DHCP応答未観測。不在の証明ではありません")
    servers = sorted({r["server"] for r in observed_responses})
    relays = sorted({f"{r['server']}←{r['relay']}" for r in observed_responses if r.get("relay")})
    context = f"。配布元 {', '.join(servers)}"
    if relays:
        context += f"、relay経由 {', '.join(relays)}"
    if len(servers) > 1:
        context += "。複数配布元は冗長構成の可能性があります"
    if approved is None:
        return Evaluation("inconclusive", "承認DHCP基準未設定" + context)
    unexpected = sorted(set(servers) - set(approved))
    if unexpected:
        return Evaluation(
            "finding", "承認基準にないDHCP配布元候補: " + ", ".join(unexpected) + context
        )
    differences = set()
    for r in observed_responses:
        if expected_gateway is not None and r.get("gateway") not in (None, *expected_gateway):
            differences.add(f"{r['server']} GW {r['gateway']}")
        extra = [d for d in r.get("dns", []) if expected_dns is not None and d not in expected_dns]
        if extra:
            differences.add(f"{r['server']} DNS {', '.join(extra)}")
    if differences:
        return Evaluation(
            "finding", "配布内容が基準と異なります: " + "; ".join(sorted(differences)) + context
        )
    unset = expected_gateway is None or expected_dns is None
    return Evaluation(
        "noFindingInScope",
        "観測した配布元は基準内"
        + ("。配布内容の基準未設定（GW/DNSは未評価）" if unset else "")
        + context
        + "。未観測の配布元は評価できません",
    )


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


def ipv6_finding(enabled, inventory, unused=True):
    base = {"id": "ipv6-local-v1", "itemNo": 12, "observationIds": []}
    if not enabled:
        reason = "IPv6ローカル設定確認OFF。IPv6設定未確認（IPv6経路なしとは判定しません）"
        return {**base, **Evaluation("inconclusive", reason).to_dict()}
    status = inventory.get("ipv6") or {}
    if status.get("state") != "completed":
        reason = f"IPv6設定未確認: {status.get('reason') or '取得失敗'}"
        return {**base, **Evaluation("inconclusive", reason).to_dict()}
    addresses = [a for a in inventory.get("addresses", []) if a.get("family") == "IPv6"]
    routes = [
        r
        for r in inventory.get("routes", [])
        if r.get("family") == "IPv6" and r.get("prefix") == "::/0"
    ]
    return {**base, **evaluate_ipv6(addresses, routes, True, unused).to_dict()}


def same_device_candidates(values):
    return [{**value, "certainty": "candidate"} for value in values]


def dns_statistics(packets, capture_end=None, host_ips=(), tail_seconds=5):
    """Pairs queries and answers by client, server, id and question; own-host traffic apart."""
    queries, answers = {}, {}
    for p in packets:
        if p.get("response"):
            key = (p.get("destination"), p.get("ip"), p.get("transaction"), p.get("questionHash"))
            answers.setdefault(key, []).append(p)
        else:
            key = (p.get("ip"), p.get("destination"), p.get("transaction"), p.get("questionHash"))
            queries.setdefault(key, []).append(p)
    stats = {
        "queries": 0,
        "answered": 0,
        "unanswered": 0,
        "pendingAtEnd": 0,
        "retransmissions": 0,
        "selfHost": 0,
        "unmatchedResponses": 0,
        "rcodes": {},
    }
    for key, sent in queries.items():
        if key[0] in host_ips:
            stats["selfHost"] += 1
            continue
        stats["queries"] += 1
        stats["retransmissions"] += len(sent) - 1
        last = max(p.get("epoch") or 0 for p in sent)
        if key in answers:
            stats["answered"] += 1
        elif capture_end is not None and last >= capture_end - tail_seconds:
            stats["pendingAtEnd"] += 1
        else:
            stats["unanswered"] += 1
    for key, received in answers.items():
        if key[0] in host_ips:
            continue
        if key not in queries:
            stats["unmatchedResponses"] += 1
        code = received[-1].get("rcode") or "unknown"
        stats["rcodes"][code] = stats["rcodes"].get(code, 0) + 1
    return stats


def evaluate_dns(
    packets,
    expected=None,
    configured=None,
    *,
    captured=True,
    capture_end=None,
    host_ips=(),
    failure_ratio=None,
):
    configured = configured or []
    host_ips = set(host_ips)
    stats = dns_statistics(packets, capture_end, host_ips)
    summary = (
        f"問い合わせ{stats['queries']}件（応答{stats['answered']}・無応答{stats['unanswered']}"
        f"・期間末尾{stats['pendingAtEnd']}・再送{stats['retransmissions']}"
        f"・対応なし応答{stats['unmatchedResponses']}）、自ホスト分{stats['selfHost']}件は別集計、"
        f"応答コード{stats['rcodes']}。DoH/DoT（暗号化DNS）の中身は観測対象外です"
    )
    if expected is not None:
        destinations = {
            p.get("destination") for p in packets if not p.get("response") and p.get("destination")
        }
        unexpected = sorted((set(configured) | destinations) - set(expected))
        if unexpected:
            return Evaluation("finding", "想定外DNS設定/宛先候補: " + ", ".join(unexpected))
    failures = stats["rcodes"].get("2", 0) + stats["unanswered"]
    sample = stats["answered"] + stats["unmatchedResponses"] + stats["unanswered"]
    if failure_ratio is not None and failures >= 2 and failures / sample >= failure_ratio:
        return Evaluation(
            "finding", f"SERVFAIL・無応答が閾値以上（{failures}/{sample}）。{summary}"
        )
    if not captured:
        return Evaluation("inconclusive", f"DNS観測失敗または未実施。{summary}")
    if expected is None:
        return Evaluation("inconclusive", f"想定DNS基準未設定。観測統計だけを表示します。{summary}")
    if not configured and not packets:
        return Evaluation("inconclusive", "DNS設定/通信を確認できません")
    if stats["queries"] and not stats["answered"] and not stats["unmatchedResponses"]:
        return Evaluation(
            "inconclusive", f"問い合わせのみ観測し応答は未観測。観測点・ドロップを確認。{summary}"
        )
    return Evaluation(
        "noFindingInScope",
        f"取得したDNS設定/宛先は基準内。単発NXDOMAINや無応答から障害を断定しません。{summary}",
    )


def findings_for(observations, capture, profile):
    """capture: {"succeeded": bool, "endEpoch": float|None}. OFF features stay unchecked."""
    features = profile.get("features", {})
    captured = capture.get("succeeded", False)
    host = next(
        (
            o["value"]
            for o in observations
            if o["type"] == "hostConfiguration" and o["source"] == "powershell"
        ),
        {},
    )
    host_ips = {a["address"] for a in host.get("addresses", []) if a.get("family") == "IPv4"}
    configured = [
        address
        for entry in host.get("dns", [])
        if entry.get("ifIndex") == profile.get("ifIndex")
        for address in entry.get("addresses", [])
        if "." in address
    ]

    def ids(kind):
        return [o["id"] for o in observations if o["type"] == kind]

    if features.get("dhcp"):
        dhcp = evaluate_dhcp(
            [o["value"] for o in observations if o["type"] == "dhcp"],
            captured,
            profile.get("approvedDhcp"),
            profile.get("expectedGateway"),
            profile.get("expectedDns"),
        )
    else:
        dhcp = Evaluation("inconclusive", "DHCP監査OFF。DHCPは未確認です（対象外にはしません）")
    if features.get("dns"):
        dns = evaluate_dns(
            [o["value"] for o in observations if o["type"] == "dns"],
            profile.get("expectedDns"),
            configured,
            captured=captured,
            capture_end=capture.get("endEpoch"),
            host_ips=host_ips,
            failure_ratio=profile.get("dnsFailureRatio"),
        )
    else:
        dns = Evaluation("inconclusive", "DNS監査OFF。DNSは未確認です（対象外にはしません）")
    findings = [
        {"id": "dhcp-server-v1", "itemNo": 14, **dhcp.to_dict(), "observationIds": ids("dhcp")},
        {"id": "dns-v1", "itemNo": 17, **dns.to_dict(), "observationIds": ids("dns")},
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
