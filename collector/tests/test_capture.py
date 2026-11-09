"""DHCP offer content, TShark drops/outcome/capacity and opt-in detailed DNS evidence."""

import pytest

from collector.core import (
    capture_outcome,
    capture_stats,
    complete_lines,
    evaluate_dhcp,
    ipv6_finding,
    normalize_tshark,
)
from collector.runner import finish_capture


def tsv(header, rows):
    return "\n".join("\t".join(r) for r in [header, *rows]) + "\n"


def offer(server, gw="192.168.1.1", dns=("192.168.1.2",), relay=None):
    return {
        "server": server,
        "ip": server,
        "relay": relay,
        "message": "5",
        "mac": None,
        "offeredAddress": "192.168.1.60",
        "gateway": gw,
        "dns": list(dns),
        "leaseSeconds": 86400,
    }


def test_offered_gateway_and_dns_are_judged_only_against_a_baseline():
    good = [offer("192.168.1.1")]
    assert (
        evaluate_dhcp(
            good,
            True,
            ["192.168.1.1"],
            expected_gateway=["192.168.1.1"],
            expected_dns=["192.168.1.2"],
        ).status
        == "noFindingInScope"
    )
    wrong_gw = evaluate_dhcp(
        [offer("192.168.1.1", gw="192.168.1.254")],
        True,
        ["192.168.1.1"],
        expected_gateway=["192.168.1.1"],
    )
    assert wrong_gw.status == "finding"
    assert "192.168.1.254" in wrong_gw.reason
    wrong_dns = evaluate_dhcp(
        [offer("192.168.1.1", dns=("8.8.8.8",))],
        True,
        ["192.168.1.1"],
        expected_dns=["192.168.1.2"],
    )
    assert wrong_dns.status == "finding"
    unset = evaluate_dhcp(good, True, ["192.168.1.1"])
    assert unset.status == "noFindingInScope"
    assert "配布内容の基準未設定" in unset.reason


def test_relay_and_redundant_servers_are_listed_not_condemned():
    responses = [offer("192.168.1.1"), offer("10.0.0.5", relay="192.168.1.1")]
    result = evaluate_dhcp(responses, True, ["192.168.1.1", "10.0.0.5"])
    assert result.status == "noFindingInScope"
    assert "relay" in result.reason
    assert "10.0.0.5" in result.reason


DHCP_HEADER = [
    "frame.time_epoch",
    "ip.src",
    "dhcp.option.dhcp",
    "dhcp.option.dhcp_server_id",
    "dhcp.ip.relay",
    "dhcp.ip.your",
    "dhcp.option.router",
    "dhcp.option.domain_name_server",
    "dhcp.option.ip_address_lease_time",
    "eth.src",
]
DHCP_ROW = [
    "123",
    "192.168.1.1",
    "2",
    "192.168.1.1",
    "0.0.0.0",
    "192.168.1.60",
    "192.168.1.1",
    "192.168.1.2,192.168.1.3",
    "86400",
    "00:11:22:33:44:55",
]


def test_dhcp_offer_fields_are_normalized_and_validated():
    observations, omitted = normalize_tshark(tsv(DHCP_HEADER, [DHCP_ROW]), "seg")
    value = observations[0]["value"]
    assert omitted == 0
    assert value["relay"] is None
    assert value["dns"] == ["192.168.1.2", "192.168.1.3"]
    assert value["gateway"] == "192.168.1.1"
    assert value["leaseSeconds"] == 86400
    bad = [*DHCP_ROW]
    bad[7] = "evil"
    with pytest.raises(ValueError):
        normalize_tshark(tsv(DHCP_HEADER, [bad]), "seg")


def test_tshark_summary_reports_drops_or_unknown():
    assert capture_stats("Capturing on 'Ethernet'\n120 packets captured\n") == {
        "captured": 120,
        "dropped": 0,
    }
    text = "Capturing on 'Ethernet'\n3 packets dropped from Ethernet\n120 packets captured\n"
    assert capture_stats(text) == {"captured": 120, "dropped": 3}
    assert capture_stats("1 packet dropped\n1 packet captured\n") == {"captured": 1, "dropped": 1}
    # Killed before the summary: drops cannot be known and are never reported as zero.
    assert capture_stats("Capturing on 'Ethernet'\n") == {"captured": None, "dropped": None}


def test_zero_rows_permission_early_stop_capacity_and_parse_errors_are_distinct():
    zero = capture_outcome(0, "0 packets captured\n", None, 0, None)
    assert zero["state"] == "completed"
    assert "0件" in zero["reason"]
    assert zero["dropped"] == 0
    denied = capture_outcome(
        2, "tshark: You don't have permission to capture on that device", None, 0, None
    )
    assert denied["state"] == "failed"
    assert "権限" in denied["reason"]
    assert capture_outcome(None, "", "cancelled", 5, None)["state"] == "cancelled"
    assert capture_outcome(None, "", "deadline", 5, None)["state"] == "timedOut"
    capacity = capture_outcome(None, "", "capacity", 5, None)
    assert capacity["state"] == "truncated"
    assert capacity["dropped"] is None
    parse = capture_outcome(0, "9 packets captured\n", None, 0, "unsupported TShark fields")
    assert parse["state"] == "failed"
    assert "解析" in parse["reason"]


ARP_HEADER = ["frame.time_epoch", "arp.src.proto_ipv4", "arp.src.hw_mac"]


def test_capacity_truncation_keeps_complete_rows_and_counts_omissions():
    rows = [[str(100 + n), f"192.168.1.{n}", "00:11:22:33:44:55"] for n in range(1, 4)]
    text = tsv(ARP_HEADER, rows) + "104\t192.168.1."  # interrupted mid-row
    with pytest.raises(ValueError):
        normalize_tshark(text, "seg")
    observations, omitted = normalize_tshark(complete_lines(text), "seg", limit=2)
    assert len(observations) == 2
    assert omitted == 1


DNS_HEADER = [
    "frame.time_epoch",
    "ip.src",
    "ip.dst",
    "dns.flags.response",
    "dns.flags.rcode",
    "dns.id",
    "dns.qry.name",
]


def test_dns_names_are_hashed_unless_detailed_evidence_is_chosen():
    text = tsv(
        DNS_HEADER, [["123.5", "192.168.1.50", "192.168.1.2", "0", "0", "0x1", "intra.example\x07"]]
    )
    hashed, _ = normalize_tshark(text, "seg")
    assert "question" not in hashed[0]["value"]
    assert hashed[0]["value"]["epoch"] == 123.5
    kept, _ = normalize_tshark(text, "seg", keep_names=True)
    assert kept[0]["value"]["question"] == "intra.example"


def test_ipv6_off_or_failed_is_unchecked_and_never_reported_absent():
    off = ipv6_finding(False, {})
    assert off["status"] == "inconclusive"
    assert "OFF" in off["reason"]
    failed = ipv6_finding(
        True, {"ipv6": {"state": "failed", "reason": "denied"}, "addresses": [], "routes": []}
    )
    assert failed["status"] == "inconclusive"
    assert "denied" in failed["reason"]
    found = ipv6_finding(
        True,
        {
            "ipv6": {"state": "completed", "reason": None},
            "addresses": [{"family": "IPv6", "address": "fe80::1"}],
            "routes": [{"family": "IPv6", "prefix": "::/0", "nextHop": "fe80::2"}],
        },
    )
    assert found["status"] == "finding"
    assert found["itemNo"] == 12


def test_capture_finish_wires_stop_reason_rows_and_limits():
    rows = [[str(100 + n), f"192.168.1.{n}", "00:11:22:33:44:55"] for n in range(1, 4)]
    cut = tsv(ARP_HEADER, rows) + "104\t192.168.1."
    observations, entry = finish_capture(cut, "", None, "capacity", "seg", 100000, False)
    assert len(observations) == 3
    assert entry["state"] == "truncated"
    assert entry["dropped"] is None
    observations, entry = finish_capture("", "0 packets captured\n", 0, None, "seg", 100000, False)
    assert observations == []
    assert entry["state"] == "completed"
    assert "0件" in entry["reason"]
    _, entry = finish_capture(
        tsv(ARP_HEADER, rows), "3 packets captured\n", 0, None, "seg", 2, False
    )
    assert entry["state"] == "truncated"
    assert entry["omitted"] == 1
    _, entry = finish_capture("bogus\theader\n", "1 packet captured\n", 0, None, "seg", 10, False)
    assert entry["state"] == "failed"
