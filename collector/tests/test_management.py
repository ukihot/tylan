import pytest

from collector.management import validate_management


def test_management_accepts_only_explicit_ipv4_targets_and_fixed_readers():
    config = {"ad": {"server": "192.168.1.2", "searchBase": "OU=Devices,DC=example,DC=internal"}, "dhcpServers": ["192.168.1.3"], "windows": ["192.168.1.4"]}
    assert validate_management(config)["targets"] == ["192.168.1.2", "192.168.1.3", "192.168.1.4"]
    for bad in ({"command": "whoami"}, {"windows": ["dc.example"]}, {"ad": {"server": "::1", "searchBase": "DC=x"}}, {"windows": ["127.0.0.1"]}, {"credential": "secret"}):
        with pytest.raises(ValueError):
            validate_management(bad)
