"""Validate optional read-only management targets, never discover more targets implicitly."""

import ipaddress
import re


def validate_management(value):
    if not isinstance(value, dict) or set(value) - {"ad", "dhcpServers", "windows"}:
        raise ValueError("unsupported management reader")
    targets = set()
    for kind, limit in (("dhcpServers", 10), ("windows", 50)):
        addresses = value.get(kind, [])
        if not isinstance(addresses, list) or len(addresses) > limit:
            raise ValueError("too many management targets")
        targets.update(addresses)
    if value.get("ad"):
        ad = value["ad"]
        if not isinstance(ad, dict) or set(ad) != {"server", "searchBase"}:
            raise ValueError("fixed AD server/search base required")
        if (
            not isinstance(ad["searchBase"], str)
            or not 1 <= len(ad["searchBase"]) <= 2000
            or re.search(r"[\x00-\x1f]", ad["searchBase"])
        ):
            raise ValueError("invalid AD search base")
        targets.add(ad["server"])
    for address in targets:
        ip = ipaddress.IPv4Address(address)
        if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
            raise ValueError("invalid management destination")
    return {**value, "targets": sorted(targets, key=ipaddress.IPv4Address)}
