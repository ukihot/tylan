# Fixed, read-only local inventory. Never enables WinRM, changes routes or renews DHCP.
param([Parameter(Mandatory=$true)][string]$Output, [string]$Targets = '', [switch]$IncludeIPv6)
$ErrorActionPreference = 'Stop'
$families = @('IPv4')
if ($IncludeIPv6) { $families += 'IPv6' }
$adapters = @(Get-NetAdapter | ForEach-Object {
  [ordered]@{ ifIndex = [int]$_.ifIndex; guid = $_.InterfaceGuid.ToString(); name = $_.Name; description = $_.InterfaceDescription; mac = $_.MacAddress.Replace('-', ':').ToLowerInvariant(); status = $_.Status.ToString(); hardware = [bool]$_.HardwareInterface }
})
$addresses = @(Get-NetIPAddress -AddressFamily $families | ForEach-Object {
  [ordered]@{ ifIndex = [int]$_.InterfaceIndex; address = $_.IPAddress; prefixLength = [int]$_.PrefixLength; family = $_.AddressFamily.ToString(); state = $_.AddressState.ToString(); origin = $_.PrefixOrigin.ToString(); skipAsSource = [bool]$_.SkipAsSource }
})
$interfaces = @(Get-NetIPInterface -AddressFamily $families)
$routes = @(Get-NetRoute -AddressFamily $families | ForEach-Object {
  $r = $_
  $metric = @($interfaces | Where-Object { $_.InterfaceIndex -eq $r.InterfaceIndex -and $_.AddressFamily -eq $r.AddressFamily } | Select-Object -First 1)
  $interfaceMetric = if ($metric.Count) { [int]$metric[0].InterfaceMetric } else { 0 }
  [ordered]@{ prefix = $r.DestinationPrefix; ifIndex = [int]$r.InterfaceIndex; nextHop = $r.NextHop; metric = [int]$r.RouteMetric + $interfaceMetric; family = $r.AddressFamily.ToString(); protocol = $r.Protocol.ToString(); validLifetime = $r.ValidLifetime.ToString() }
})
$best = @()
if ($Targets) {
  $ips = @(Get-Content -LiteralPath $Targets -Encoding UTF8)
  if ($ips.Count -gt 4096) { throw 'too many route targets' }
  $best = @($ips | ForEach-Object {
    $ip = $_
    $parsed = [System.Net.IPAddress]::Parse($ip)
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 only' }
    # No InterfaceIndex restriction: inspect the actual OS choice, including VPN host routes.
    $choice = @(Find-NetRoute -RemoteIPAddress $ip)
    $address = @($choice | Where-Object { $_.PSObject.Properties['IPAddress'] })
    $route = @($choice | Where-Object { $_.PSObject.Properties['DestinationPrefix'] })
    if ($address.Count -ne 1 -or $route.Count -ne 1) { throw 'ambiguous best route' }
    [ordered]@{ target = $ip; source = $address[0].IPAddress; ifIndex = [int]$route[0].InterfaceIndex; nextHop = $route[0].NextHop; prefix = $route[0].DestinationPrefix }
  })
}
$dns = @(Get-DnsClientServerAddress | ForEach-Object { [ordered]@{ ifIndex = [int]$_.InterfaceIndex; addresses = @($_.ServerAddresses) } })
$dhcp = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object {
  [ordered]@{ ifIndex = [int]$_.InterfaceIndex; enabled = [bool]$_.DHCPEnabled; server = $_.DHCPServer; obtained = [string]$_.DHCPLeaseObtained; expires = [string]$_.DHCPLeaseExpires }
})
$neighbors = @(Get-NetNeighbor -AddressFamily IPv4 | ForEach-Object { [ordered]@{ ifIndex = [int]$_.InterfaceIndex; ip = $_.IPAddress; mac = $_.LinkLayerAddress.Replace('-', ':').ToLowerInvariant(); state = $_.State.ToString() } })
$domain = Get-CimInstance Win32_ComputerSystem -Property Domain,PartOfDomain,Name
$result = [ordered]@{ adapters = $adapters; addresses = $addresses; routes = $routes; bestRoutes = $best; dns = $dns; dhcp = $dhcp; neighbors = $neighbors; computer = [ordered]@{ name = $domain.Name; domain = $domain.Domain; domainJoined = [bool]$domain.PartOfDomain } }
[System.IO.File]::WriteAllText($Output, (ConvertTo-Json -InputObject $result -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
