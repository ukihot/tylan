import pytest

from collector.exports import offline_collection
from collector.runner import nmap_interface, validate_profile


def test_default_profile_cannot_start_ipv6_or_arbitrary_commands():
    base = {
        "mode": "passive",
        "features": {
            "arp": True,
            "dns": True,
            "dhcp": True,
            "ipv6Local": True,
            "discovery": False,
            "ports": False,
        },
    }
    assert validate_profile(base)["mode"] == "passive"
    for extra in (
        {"command": "evil"},
        {"ipv6Scan": True},
        {"duration": 0},
        {"ports": [0]},
        {"mode": "unknown"},
    ):
        with pytest.raises(ValueError):
            validate_profile({**base, **extra})


def test_nmap_interface_must_match_real_address_and_mac():
    text = "DEV (SHORT) IP/MASK TYPE UP MTU MAC\neth0 (eth0) 192.168.10.20/24 ethernet up 1500 00:11:22:33:44:55\n"
    assert nmap_interface(text, "192.168.10.20", "00:11:22:33:44:55") == "eth0"
    with pytest.raises(ValueError):
        nmap_interface(text, "192.168.10.21", "00:11:22:33:44:55")


PASSIVE = {"mode": "passive", "siteId": "site1"}


def test_detail_evidence_needs_an_explicit_retention_period():
    kept = validate_profile({**PASSIVE, "detailEvidence": {"dnsNames": True, "retentionDays": 90}})
    assert kept["detailEvidence"] == {"dnsNames": True, "retentionDays": 90}
    for bad in (
        {"dnsNames": True},
        {"dnsNames": True, "retentionDays": 0},
        {"dnsNames": True, "retentionDays": 90, "rawCapture": True},
        {"dnsNames": "yes", "retentionDays": 90},
    ):
        with pytest.raises(ValueError):
            validate_profile({**PASSIVE, "detailEvidence": bad})


def test_gateway_baseline_and_dns_failure_threshold_are_validated():
    valid = validate_profile(
        {**PASSIVE, "expectedGateway": ["192.168.1.1"], "dnsFailureRatio": 0.2}
    )
    assert valid["dnsFailureRatio"] == 0.2
    for extra in ({"expectedGateway": ["gw"]}, {"dnsFailureRatio": 2}, {"dnsFailureRatio": True}):
        with pytest.raises(ValueError):
            validate_profile({**PASSIVE, **extra})


SWITCH = {
    "format": "tylan-switch-export",
    "schemaVersion": 1,
    "vendor": "generic",
    "records": [
        {
            "protocol": "lldp",
            "localDevice": "SW-1",
            "localPort": "Gi1",
            "remoteDevice": "AP-1",
            "remotePort": "eth0",
        }
    ],
}


def test_offline_switch_import_needs_no_nic_and_cannot_carry_targets():
    profile = validate_profile({"mode": "offline", "siteId": "site1", "switchExport": SWITCH})
    result = offline_collection(profile, "run1", "2026-11-06T12:00:00+09:00")
    assert result["scope"]["observationPoint"] == "imported"
    assert result["scope"]["targets"] == []
    assert [c["state"] for c in result["collectors"]] == ["completed"]
    assert result["observations"][0]["type"] == "physicalCandidate"
    for bad in (
        {"cidrs": ["192.168.1.0/24"]},
        {"management": {"windows": ["192.168.1.4"]}},
        {"switchExport": {**SWITCH, "password": "x"}},
    ):
        with pytest.raises(ValueError):
            validate_profile({"mode": "offline", "siteId": "site1", "switchExport": SWITCH, **bad})
    with pytest.raises(ValueError):
        validate_profile({**PASSIVE, "switchExport": SWITCH})
