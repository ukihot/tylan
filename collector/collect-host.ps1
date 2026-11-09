# Fixed, read-only local inventory. Never enables WinRM, changes routes or renews DHCP.
# IPv6 is a separate, send-free read: its failure leaves IPv6 unchecked and IPv4 collection intact.
param([Parameter(Mandatory=$true)][string]$Output, [string]$Targets = '', [switch]$IncludeIPv6)
$ErrorActionPreference = 'Stop'
function Address-Dto($a) {
  [ordered]@{ ifIndex = [int]$a.InterfaceIndex; address = $a.IPAddress; prefixLength = [int]$a.PrefixLength; family = $a.AddressFamily.ToString(); state = $a.AddressState.ToString(); origin = $a.PrefixOrigin.ToString(); skipAsSource = [bool]$a.SkipAsSource }
}
function Route-Dtos([string]$family) {
  $interfaces = @(Get-NetIPInterface -AddressFamily $family)
  @(Get-NetRoute -AddressFamily $family | ForEach-Object {
    $r = $_
    $metric = @($interfaces | Where-Object { $_.InterfaceIndex -eq $r.InterfaceIndex } | Select-Object -First 1)
    $interfaceMetric = if ($metric.Count) { [int]$metric[0].InterfaceMetric } else { 0 }
    [ordered]@{ prefix = $r.DestinationPrefix; ifIndex = [int]$r.InterfaceIndex; nextHop = $r.NextHop; metric = [int]$r.RouteMetric + $interfaceMetric; family = $r.AddressFamily.ToString(); protocol = $r.Protocol.ToString(); validLifetime = $r.ValidLifetime.ToString() }
  })
}
$adapters = @(Get-NetAdapter | ForEach-Object {
  [ordered]@{ ifIndex = [int]$_.ifIndex; guid = $_.InterfaceGuid.ToString(); name = $_.Name; description = $_.InterfaceDescription; mac = $_.MacAddress.Replace('-', ':').ToLowerInvariant(); status = $_.Status.ToString(); hardware = [bool]$_.HardwareInterface }
})
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { Address-Dto $_ })
$routes = @(Route-Dtos 'IPv4')
$ipv6 = [ordered]@{ state = 'skipped'; reason = 'IPv6 local check OFF' }
if ($IncludeIPv6) {
  try {
    $v6Addresses = @(Get-NetIPAddress -AddressFamily IPv6 | ForEach-Object { Address-Dto $_ })
    $v6Routes = @(Route-Dtos 'IPv6')
    $addresses += $v6Addresses
    $routes += $v6Routes
    $ipv6 = [ordered]@{ state = 'completed'; reason = $null }
  } catch {
    $ipv6 = [ordered]@{ state = 'failed'; reason = $_.Exception.Message }
  }
}
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
$result = [ordered]@{ adapters = $adapters; addresses = $addresses; routes = $routes; ipv6 = $ipv6; bestRoutes = $best; dns = $dns; dhcp = $dhcp; neighbors = $neighbors; computer = [ordered]@{ name = $domain.Name; domain = $domain.Domain; domainJoined = [bool]$domain.PartOfDomain } }
[System.IO.File]::WriteAllText($Output, (ConvertTo-Json -InputObject $result -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
