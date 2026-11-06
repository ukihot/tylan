import pytest

from collector.core import evaluate_dns
from collector.exports import normalize_switch_export


def test_dns_single_nxdomain_and_missing_baseline_are_not_health_certificates():
    packets = [{"response": True, "rcode": "3", "ip": "192.168.1.1", "destination": "192.168.1.2"}]
    assert evaluate_dns(packets, None, ["192.168.1.1"]).status == "inconclusive"
    assert evaluate_dns(packets, ["192.168.1.1"], ["192.168.1.1"]).status != "finding"
    assert evaluate_dns([], ["192.168.1.1"], ["8.8.8.8"]).status == "finding"


def test_switch_exports_are_evidence_candidates_and_mac_table_is_not_a_cable():
    export = {"format": "tylan-switch-export", "schemaVersion": 1, "vendor": "generic", "records": [
        {"protocol": "lldp", "localDevice": "SW-1", "localPort": "Gi1", "remoteDevice": "AP-1", "remotePort": "eth0"},
        {"protocol": "mac-table", "localDevice": "SW-1", "localPort": "Gi2", "remoteDevice": "00:11:22:33:44:55", "remotePort": None},
    ]}
    observations = normalize_switch_export(export, "site", "2026-11-06T12:00:00+09:00")
    assert observations[0]["type"] == "physicalCandidate"
    assert observations[1]["value"]["linkKind"] == "logical"
    assert observations[0]["value"]["certainty"] == "estimated"
    with pytest.raises(ValueError):
        normalize_switch_export({**export, "password": "never collect"}, "site", "now")
