# Fixed read-only readers. No credentials, remote enablement or arbitrary script input.
param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$config = ConvertFrom-Json ([System.IO.File]::ReadAllText($InputFile, $utf8))
$ip = [System.Net.IPAddress]::Parse($config.server)
if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 management only' }
$records = @()
$state = 'completed'
$reason = $null
try {
  switch ($config.kind) {
    'ad' {
      if (-not (Get-Module -ListAvailable ActiveDirectory)) { $state = 'skipped'; $reason = 'ActiveDirectory module unavailable'; break }
      Import-Module ActiveDirectory -ErrorAction Stop
      $records = @(Get-ADComputer -Server $config.server -SearchBase $config.searchBase -Filter * -ResultSetSize 10000 -Properties DNSHostName,OperatingSystem,Enabled | ForEach-Object {
        [ordered]@{ name = $_.Name; objectGUID = $_.ObjectGUID.ToString(); dnsHostName = $_.DNSHostName; operatingSystem = $_.OperatingSystem; enabled = [bool]$_.Enabled }
      })
      if ($records.Count -ge 10000) { $state = 'partial'; $reason = 'AD result limit reached' }
    }
    'dhcp' {
      if (-not (Get-Module -ListAvailable DhcpServer)) { $state = 'skipped'; $reason = 'DhcpServer module unavailable'; break }
      Import-Module DhcpServer -ErrorAction Stop
      $scopes = @(Get-DhcpServerv4Scope -ComputerName $config.server | Select-Object -First 100)
      $records = @($scopes | ForEach-Object {
        $scope = $_
        $exclusions = @(Get-DhcpServerv4ExclusionRange -ComputerName $config.server -ScopeId $scope.ScopeId | ForEach-Object { [ordered]@{ start = $_.StartRange.ToString(); end = $_.EndRange.ToString() } })
        $reservations = @(Get-DhcpServerv4Reservation -ComputerName $config.server -ScopeId $scope.ScopeId | Select-Object -First 5000 | ForEach-Object { [ordered]@{ address = $_.IPAddress.ToString(); clientId = $_.ClientId } })
        $leases = @(Get-DhcpServerv4Lease -ComputerName $config.server -ScopeId $scope.ScopeId | Select-Object -First 5000 | ForEach-Object { [ordered]@{ address = $_.IPAddress.ToString(); clientId = $_.ClientId; state = $_.AddressState.ToString(); expiry = [string]$_.LeaseExpiryTime } })
        $options = @(Get-DhcpServerv4OptionValue -ComputerName $config.server -ScopeId $scope.ScopeId | Where-Object { $_.OptionId -in @(3,6) } | ForEach-Object { [ordered]@{ optionId = [int]$_.OptionId; values = @($_.Value | ForEach-Object { [string]$_ }) } })
        [ordered]@{ server = $config.server; scopeId = $scope.ScopeId.ToString(); name = $scope.Name; subnetMask = $scope.SubnetMask.ToString(); start = $scope.StartRange.ToString(); end = $scope.EndRange.ToString(); leaseSeconds = $scope.LeaseDuration.TotalSeconds; exclusions = $exclusions; reservations = $reservations; leases = $leases; options = $options }
      })
      if ($scopes.Count -ge 100 -or @($records | Where-Object { $_.leases.Count -ge 5000 -or $_.reservations.Count -ge 5000 }).Count) { $state = 'partial'; $reason = 'DHCP record limit reached' }
    }
    'windows' {
      $records = @(Get-CimInstance Win32_NetworkAdapterConfiguration -ComputerName $config.server -Filter 'IPEnabled=True' -OperationTimeoutSec 10 | ForEach-Object {
        [ordered]@{ server = $config.server; name = $_.Description; ifIndex = [int]$_.InterfaceIndex; addresses = @($_.IPAddress | Where-Object { ([System.Net.IPAddress]::Parse($_)).AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork }); mac = $_.MACAddress; dhcpEnabled = [bool]$_.DHCPEnabled; dhcpServer = $_.DHCPServer; dns = @($_.DNSServerSearchOrder); gateways = @($_.DefaultIPGateway) }
      })
    }
    default { throw 'unsupported management reader' }
  }
} catch { $state = 'failed'; $reason = $_.Exception.Message; $records = @() }
$result = [ordered]@{ kind = $config.kind; state = $state; reason = $reason; records = $records }
[System.IO.File]::WriteAllText($Output, (ConvertTo-Json -InputObject $result -Depth 20 -Compress), $utf8)
