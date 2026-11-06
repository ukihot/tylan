import pytest

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
