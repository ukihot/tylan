import random

import pytest

from collector.core import (
    authorize_targets,
    capture_filter,
    evaluate_dhcp,
    evaluate_ipv6,
    normalize_nmap,
    normalize_tshark,
    same_device_candidates,
)


def route(prefix="192.168.10.0/24", nic=4, hop="0.0.0.0", metric=10):
    return {"prefix": prefix, "ifIndex": nic, "nextHop": hop, "metric": metric}


def profile(**changes):
    return {
        "cidrs": ["192.168.10.0/24"],
        "exclude": [],
        "source": "192.168.10.20",
        "prefixLength": 24,
        "ifIndex": 4,
        "mode": "standard",
        **changes,
    }


def test_dhcp_response_not_observed():
    assert evaluate_dhcp([], True).status == "inconclusive"
    assert evaluate_dhcp([], False).status == "inconclusive"


def test_dhcp_redundancy_and_missing_baseline_are_not_rogue():
    responses = [{"server": "192.168.10.1"}, {"server": "192.168.10.2"}]
    assert evaluate_dhcp(responses, True).status == "inconclusive"
    assert (
        evaluate_dhcp(responses, True, ["192.168.10.1", "192.168.10.2"]).status
        == "noFindingInScope"
    )
    assert evaluate_dhcp(responses, True, ["192.168.10.1"]).status == "finding"


def test_nmap_missing_mac_filtered_and_partial_are_preserved():
    xml = '<nmaprun><host><status state="up" reason="arp-response"/><address addr="192.168.10.2" addrtype="ipv4"/><ports><port protocol="tcp" portid="445"><state state="filtered" reason="no-response"/></port></ports></host></nmaprun>'
    result = normalize_nmap(xml, "seg", "2026-11-06T12:00:00+09:00")
    assert result[0]["value"]["mac"] is None
    assert result[0]["value"]["vendor"] is None
    with_vendor = xml.replace(
        "<ports>",
        '<address addr="58:38:79:BE:1F:65" addrtype="mac" vendor="Ricoh Company"/><ports>',
    )
    value = normalize_nmap(with_vendor, "seg", "now")[0]["value"]
    assert (value["mac"], value["vendor"]) == ("58:38:79:be:1f:65", "Ricoh Company")
    assert result[0]["value"]["ports"] == [
        {"protocol": "tcp", "port": 445, "state": "filtered", "reason": "no-response"}
    ]
    with pytest.raises(ValueError):
        normalize_nmap(xml[:-10], "seg", "now")
    with pytest.raises(ValueError):
        normalize_nmap('<!DOCTYPE a [<!ENTITY x "bad">]><nmaprun/>', "seg", "now")


def test_tshark_fields_ignore_ipv6_and_keep_ipv4_dhcp():
    header = [
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
        "eth.src",
    ]
    row = [
        "123",
        "192.168.10.1",
        "255.255.255.255",
        "",
        "",
        "",
        "",
        "",
        "",
        "67",
        "68",
        "2",
        "192.168.10.1",
        "0.0.0.0",
        "00:11:22:33:44:55",
    ]
    data = "\t".join(header) + "\n" + "\t".join(row) + "\n"
    observations, _ = normalize_tshark(data, "seg")
    assert observations[0]["type"] == "dhcp"
    assert observations[0]["value"]["server"] == "192.168.10.1"
    assert all("name" not in o["value"] for o in observations)


def test_filter_is_ipv4_only_and_switches_are_real():
    assert (
        capture_filter(True, True, True)
        == "arp or (ip and (port 53 or (udp and (port 67 or port 68))))"
    )
    assert capture_filter(False, False, False) is None
    assert capture_filter(False, True, False) == "ip and (port 53)"


def test_vpn_host_route_is_rejected_even_inside_local_cidr():
    with pytest.raises(ValueError, match="route"):
        authorize_targets(profile(), [route(), route("192.168.10.50/32", 8, "10.0.0.1")])
    with pytest.raises(ValueError, match="route"):
        authorize_targets(profile(), [route(), route(nic=5)])
    with pytest.raises(ValueError):
        authorize_targets(profile(cidrs=["192.168.11.0/24"]), [route()])
    with pytest.raises(ValueError):
        authorize_targets(profile(cidrs=["::/0"]), [route()])


def test_excluded_targets_are_never_authorized_generated_cases():
    rng = random.Random(20261106)
    for _ in range(80):
        excluded = {f"192.168.10.{rng.randrange(1, 255)}" for _ in range(40)}
        allowed = authorize_targets(profile(exclude=list(excluded)), [route()])
        assert not set(allowed) & excluded
        assert "192.168.10.20" not in allowed
        assert len(allowed) == len(set(allowed))


def test_ip_match_is_only_a_candidate_not_identity():
    observations = [
        {"ip": "192.168.10.1", "mac": "00:11:22:33:44:55"},
        {"ip": "192.168.10.1", "mac": "00:11:22:33:44:66"},
    ]
    result = same_device_candidates(observations)
    assert len(result) == 2
    assert all(item["certainty"] == "candidate" for item in result)


def test_ipv6_presence_does_not_claim_rogue_ra():
    assert evaluate_ipv6([{"address": "fe80::1"}], [], True).status == "noFindingInScope"
    result = evaluate_ipv6([], [{"prefix": "::/0", "nextHop": "fe80::2"}], True)
    assert result.status == "finding"
    assert "RA" not in result.reason
    assert evaluate_ipv6([], [], False).status == "inconclusive"


def test_equal_cost_routes_to_another_nic_are_ambiguous_and_refused():
    with pytest.raises(ValueError, match="ambiguous"):
        authorize_targets(profile(), [route(), route(nic=5)])
