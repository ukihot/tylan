"""AUTO-05: DNS statistics separate retransmission, no answer, end of window and own traffic."""

from collector.core import dns_statistics, evaluate_dns, findings_for, observation


def query(client, server, txid, epoch, name="h"):
    return {
        "ip": client,
        "destination": server,
        "response": False,
        "rcode": None,
        "transaction": txid,
        "questionHash": name,
        "epoch": epoch,
    }


def answer(client, server, txid, epoch, rcode="0", name="h"):
    return {
        "ip": server,
        "destination": client,
        "response": True,
        "rcode": rcode,
        "transaction": txid,
        "questionHash": name,
        "epoch": epoch,
    }


SERVER = "192.168.1.2"


def test_retransmission_end_of_window_and_own_host_are_counted_apart():
    packets = [
        query("192.168.1.50", SERVER, "1", 10.0),
        query("192.168.1.50", SERVER, "1", 11.0),  # retransmission
        answer("192.168.1.50", SERVER, "1", 11.1, "3"),
        query("192.168.1.51", SERVER, "2", 20.0),  # never answered
        query("192.168.1.52", SERVER, "3", 98.0),  # too close to the end to judge
        query("192.168.1.20", SERVER, "4", 30.0),  # the investigation host itself
        answer("192.168.1.53", SERVER, "9", 5.0, "2"),  # answer to a query before capture
    ]
    stats = dns_statistics(packets, capture_end=100.0, host_ips={"192.168.1.20"})
    assert stats == {
        "queries": 3,
        "answered": 1,
        "unanswered": 1,
        "pendingAtEnd": 1,
        "retransmissions": 1,
        "selfHost": 1,
        "unmatchedResponses": 1,
        "rcodes": {"3": 1, "2": 1},
    }


def test_single_nxdomain_and_query_only_are_not_failures():
    single = [
        query("192.168.1.50", SERVER, "1", 1.0),
        answer("192.168.1.50", SERVER, "1", 1.1, "3"),
    ]
    result = evaluate_dns(single, [SERVER], [SERVER], capture_end=100.0, failure_ratio=0.1)
    assert result.status == "noFindingInScope"
    assert "DoH/DoT" in result.reason
    only = [query("192.168.1.50", SERVER, "1", 1.0)]
    assert evaluate_dns(only, [SERVER], [SERVER], capture_end=100.0).status == "inconclusive"


def test_repeated_servfail_is_a_finding_only_with_a_threshold():
    packets = []
    for n in range(4):
        packets += [
            query("192.168.1.50", SERVER, str(n), n),
            answer("192.168.1.50", SERVER, str(n), n + 0.1, "2"),
        ]
    assert evaluate_dns(packets, [SERVER], [SERVER], capture_end=100.0).status == (
        "noFindingInScope"
    )
    flagged = evaluate_dns(packets, [SERVER], [SERVER], capture_end=100.0, failure_ratio=0.5)
    assert flagged.status == "finding"
    assert "SERVFAIL" in flagged.reason


def test_own_host_failures_never_raise_the_failure_ratio():
    packets = []
    for n in range(4):
        packets += [
            query("192.168.1.20", SERVER, str(n), n),
            answer("192.168.1.20", SERVER, str(n), n + 0.1, "2"),
        ]
    result = evaluate_dns(
        packets,
        [SERVER],
        [SERVER],
        capture_end=100.0,
        host_ips={"192.168.1.20"},
        failure_ratio=0.1,
    )
    assert result.status != "finding"


def test_failed_capture_is_not_healthy_but_a_wrong_configured_server_still_is_found():
    assert evaluate_dns([], [SERVER], [SERVER], captured=False).status == "inconclusive"
    assert evaluate_dns([], [SERVER], ["8.8.8.8"], captured=False).status == "finding"


def host_config():
    return observation(
        "hostConfiguration",
        "powershell",
        "site",
        "2026-11-06T12:00:00+09:00",
        {
            "addresses": [{"ifIndex": 4, "address": "192.168.1.20", "family": "IPv4"}],
            "dns": [
                {"ifIndex": 4, "addresses": ["8.8.8.8"]},
                {"ifIndex": 9, "addresses": ["1.1.1.1"]},
            ],
        },
    )


def profile(**changes):
    return {
        "ifIndex": 4,
        "source": "192.168.1.20",
        "expectedDns": [SERVER],
        "features": {"arp": True, "dns": True, "dhcp": True, "ipv6Local": False},
        **changes,
    }


def test_findings_wire_dns_from_the_selected_nic_configuration():
    findings = findings_for([host_config()], {"succeeded": True, "endEpoch": 100.0}, profile())
    dns = next(f for f in findings if f["itemNo"] == 17)
    assert dns["status"] == "finding"
    assert "8.8.8.8" in dns["reason"]
    assert "1.1.1.1" not in dns["reason"]  # another NIC is not the audited path


def test_disabled_features_stay_unchecked_and_never_not_applicable():
    off = profile(features={"arp": True, "dns": False, "dhcp": False, "ipv6Local": False})
    findings = findings_for([host_config()], {"succeeded": True, "endEpoch": 100.0}, off)
    by_item = {f["itemNo"]: f for f in findings}
    assert by_item[14]["status"] == "inconclusive"
    assert "OFF" in by_item[14]["reason"]
    assert by_item[17]["status"] == "inconclusive"
    assert "OFF" in by_item[17]["reason"]
    assert all(f["status"] != "notApplicable" for f in findings)
