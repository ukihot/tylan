# Typed local IPC only. Canonical JSON is saved solely by Save-Canonical in tylan.ps1.
function Prop($value, [string]$key, $fallback = $null) {
  if ($null -ne $value -and $value.PSObject.Properties[$key]) { return $value.$key }
  return $fallback
}
function Epoch-Time { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Hex-Bytes([string]$hex) {
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return ,$bytes
}
function HMAC([string]$text) {
  $algorithm = New-Object System.Security.Cryptography.HMACSHA256
  $algorithm.Key = Hex-Bytes $script:auditSecret
  try { -join ($algorithm.ComputeHash($utf8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) } finally { $algorithm.Dispose() }
}
function Local-Json([string]$path, $value) {
  [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))
  $tmp = "$path.$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $value -Depth 64 -Compress), $utf8)
  if ([System.IO.File]::Exists($path)) { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $path) }
}
function Read-Local([string]$path) {
  if (-not [System.IO.File]::Exists($path)) { return $null }
  if ((Get-Item -LiteralPath $path).Length -gt 12MB) { Fail 413 'local response too large' }
  ConvertFrom-Json ([System.IO.File]::ReadAllText($path, $utf8))
}
function Check-ID([string]$value) {
  if ($value -notmatch '^[a-zA-Z0-9_-]{1,100}$') { Fail 400 'invalid identity' }
  return $value
}
$script:auditStarted = $false
$script:auditEpoch = [guid]::NewGuid().ToString('N')
$script:auditSecret = ''
$script:auditRequests = @{}
$script:auditRuns = @{}
$script:auditImports = @{}
$script:auditLastLease = 0
$script:auditBase = Join-Path $env:LOCALAPPDATA 'tylan'
$script:auditIpc = Join-Path (Join-Path $auditBase 'audit-ipc') $auditEpoch
$script:auditRunsRoot = Join-Path $auditBase 'audit-runs'
if (-not $CollectorRoot) {
  $CollectorRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'collector')) { $PSScriptRoot } else { Split-Path -Parent $PSScriptRoot }
}
if ($AuditFixture -and -not $NoBrowser) { throw 'AuditFixture requires NoBrowser and is for offline acceptance tests only' }
function Audit-Info {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  @{ available = [bool]($python -and (Test-Path -LiteralPath (Join-Path $CollectorRoot 'collector\job_owner.py'))); protocolVersion = 1; onLinkOnly = $true; ipv6Capture = $false; ipv6Scan = $false }
}
function Start-AuditOwner {
  if ($script:auditStarted) { return }
  if (-not (Audit-Info).available) { Fail 503 'Python 3.12+ or collector unavailable; ordinary editing remains available' }
  [void][System.IO.Directory]::CreateDirectory($auditBase)
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($auditBase, $acl)
  [void][System.IO.Directory]::CreateDirectory($auditIpc)
  [void][System.IO.Directory]::CreateDirectory($auditRunsRoot)
  $key = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
  $script:auditSecret = -join ($key | ForEach-Object { $_.ToString('x2') })
  $config = @{ ipcRoot = $auditIpc; runsRoot = $auditRunsRoot; ownerEpoch = $auditEpoch; sessionId = $auditEpoch; secret = $auditSecret; evidenceRoot = (Join-Path $Root 'evidence') }
  if ($AuditFixture) { $config.fixture = $AuditFixture }
  $configPath = Join-Path $auditIpc 'config.json'
  Local-Json $configPath $config
  $python = (Get-Command python.exe).Source
  Start-Process -FilePath $python -ArgumentList @('-m', 'collector.job_owner', '--config', ('"' + $configPath + '"')) -WorkingDirectory $CollectorRoot -WindowStyle Hidden -RedirectStandardError (Join-Path $auditIpc 'owner.err') -RedirectStandardOutput (Join-Path $auditIpc 'owner.out')
  $script:auditStarted = $true
  Update-AuditLease
}
function Update-AuditLease {
  $now = Epoch-Time
  if ($script:auditStarted -and $now - $script:auditLastLease -ge 30) {
    # Python may be reading the lease at this instant; a refused replace is retried next pass.
    try {
      Local-Json (Join-Path $auditIpc 'lease.json') @{ ownerEpoch = $auditEpoch; sessionId = $auditEpoch; time = $now }
      $script:auditLastLease = $now
    } catch { }
  }
}
function Send-AuditRequest([string]$kind, $payload, [string]$key = '') {
  Start-AuditOwner
  $id = [guid]::NewGuid().ToString('N')
  if (-not $key) { $key = $id }
  $payloadJson = ConvertTo-Json -InputObject $payload -Depth 64 -Compress
  $now = Epoch-Time
  $request = [ordered]@{ protocolVersion = 1; ownerEpoch = $auditEpoch; sessionId = $auditEpoch; requestId = $id; idempotencyKey = $key; kind = $kind; payloadHash = (SHA $utf8.GetBytes($payloadJson)); nonce = [guid]::NewGuid().ToString('N'); issuedAt = $now; expiresAt = $now + 300; payloadJson = $payloadJson }
  $fields = @('protocolVersion', 'ownerEpoch', 'sessionId', 'requestId', 'kind', 'payloadHash', 'nonce', 'issuedAt', 'expiresAt', 'idempotencyKey')
  $request.signature = HMAC (($fields | ForEach-Object { [string]$request[$_] }) -join "`n")
  $script:auditRequests[$id] = $request
  Local-Json (Join-Path $auditIpc "requests\$id.json") $request
  return $id
}
function Audit-Response([string]$id) {
  [void](Check-ID $id)
  if (-not $auditRequests.ContainsKey($id)) { Fail 403 'request belongs to another session' }
  $response = Read-Local (Join-Path $auditIpc "responses\$id.json")
  if ($response) { return $response }
  $ready = Read-Local (Join-Path $auditIpc 'ready.json')
  if ($ready -and $ready.state -in @('busy', 'failed', 'stopped')) {
    $reasons = @{ busy = 'another owner is active'; failed = 'collector owner failed'; stopped = 'collector owner stopped; restart tylan.cmd to audit again (editing still works)' }
    return @{ accepted = $false; error = (Prop $ready 'error' $reasons[$ready.state]); ownerState = $ready.state }
  }
  return @{ accepted = $null; state = 'pendingAcceptance'; requestId = $id }
}
function Audit-Body($req) {
  if ($req.Body.Length -gt 12MB) { Fail 413 'audit input too large' }
  try { return ConvertFrom-Json $utf8.GetString($req.Body) } catch { Fail 400 'invalid audit JSON' }
}
function Accepted($value) {
  $reply = Json $value
  $reply.Status = 202
  return $reply
}
function Import-State([string]$id) {
  [void](Check-ID $id)
  if (-not $auditImports.ContainsKey($id)) { Fail 404 'prepare this import in the current session first' }
  return $auditImports[$id]
}
function Route-Audit($req) {
  $path, $method = $req.Path, $req.Method
  if ($path -eq '/api/audit/test-stop' -and $method -eq 'POST' -and $NoBrowser -and $auditStarted) { return Accepted @{ requestId = (Send-AuditRequest 'StopOwner' @{}) } }
  if ($path -eq '/api/audit/profiles') {
    $profilesDir = Join-Path $auditBase 'profiles'
    if ($method -eq 'GET') {
      $profiles = @()
      if (Test-Path -LiteralPath $profilesDir) { $profiles = @(Get-ChildItem -LiteralPath $profilesDir -Filter '*.json' -File | Select-Object -First 500 | ForEach-Object { Read-Local $_.FullName }) }
      return Json $profiles
    }
    if ($method -eq 'POST') {
      $body = Audit-Body $req
      if (-not $body.name -or $body.name.Length -gt 100) { Fail 400 'profile name required' }
      Start-AuditOwner
      $id = (SHA $utf8.GetBytes($body.name)).Substring(0, 32)
      Local-Json (Join-Path $profilesDir "$id.json") @{ id = $id; name = $body.name; profile = $body.profile }
      return Json @{ id = $id }
    }
  }
  if ($path -eq '/api/audit/runs' -and $method -eq 'GET') { return Json @($auditRuns.Values) }
  if ($path -eq '/api/audit/past' -and $method -eq 'GET') {
    $past = @()
    if (Test-Path -LiteralPath $auditRunsRoot) { $past = @(Get-ChildItem -LiteralPath $auditRunsRoot -Directory | Select-Object -First 500 | ForEach-Object { Read-Local (Join-Path $_.FullName 'state.json') } | Where-Object { $null -ne $_ }) }
    return Json $past
  }
  if ($path -eq '/api/audit/open' -and $method -eq 'POST') {
    $body = Audit-Body $req
    $runId = Check-ID $body.runId
    $result = Read-Local (Join-Path $auditRunsRoot "$runId\package\result.json")
    if (-not $result -or $result.runId -ne $runId) { Fail 404 'no finalized result' }
    $script:auditRuns["past-$runId"] = @{ runId = $runId; requestId = ''; siteId = (Prop $result.profile 'siteId') }
    return Json @{ runId = $runId }
  }
  if ($path -eq '/api/audit/responses' -and $method -eq 'GET') { return Json (Audit-Response $req.Query['id']) }
  if ($path -eq '/api/audit/diagnose' -and $method -eq 'POST') {
    $body = Audit-Body $req
    $id = Send-AuditRequest 'Diagnose' @{ includeIPv6 = [bool](Prop $body 'includeIPv6' $true) }
    return Accepted @{ requestId = $id }
  }
  if ($path -eq '/api/audit/plan' -and $method -eq 'POST') { return Accepted @{ requestId = (Send-AuditRequest 'Plan' (Audit-Body $req)) } }
  if ($path -eq '/api/audit/runs' -and $method -eq 'POST') {
    $body = Audit-Body $req
    $key = Check-ID $body.key
    if ($auditRuns.ContainsKey($key)) {
      if ($auditRuns[$key].profileHash -ne (SHA $utf8.GetBytes((ConvertTo-Json $body.profile -Depth 32 -Compress)))) { Fail 409 'start key differs' }
      return Accepted $auditRuns[$key]
    }
    $runId = [guid]::NewGuid().ToString('N')
    $requestId = Send-AuditRequest 'StartRun' @{ runId = $runId; profile = $body.profile } $key
    $run = @{ runId = $runId; requestId = $requestId; profileHash = (SHA $utf8.GetBytes((ConvertTo-Json $body.profile -Depth 32 -Compress))); siteId = (Prop $body.profile 'siteId') }
    $script:auditRuns[$key] = $run
    return Accepted $run
  }
  if ($path -match '^/api/audit/runs/([a-zA-Z0-9_-]{1,100})(/(result|cancel|evidence))?$') {
    $runId, $action = $Matches[1], $Matches[3]
    $known = @($auditRuns.Values | Where-Object { $_.runId -eq $runId })
    if (-not $known.Count) { Fail 403 'open this run in the current session first' }
    if ($method -eq 'POST' -and $action -eq 'cancel') { return Accepted @{ requestId = (Send-AuditRequest 'CancelRun' @{ runId = $runId }) } }
    if ($method -eq 'GET' -and $action -eq 'result') {
      $result = Read-Local (Join-Path $auditRunsRoot "$runId\package\result.json")
      if (-not $result) { Fail 404 'result not finalized' }
      return Json $result
    }
    if ($method -eq 'POST' -and $action -eq 'evidence') {
      return Accepted @{ requestId = (Send-AuditRequest 'SealEvidence' @{ runId = $runId; siteId = $known[0].siteId }) }
    }
    if ($method -eq 'GET' -and -not $action) {
      $response = if ($known[0].requestId) { Audit-Response $known[0].requestId } else { @{ accepted = $true } }
      if ($response.accepted -eq $true -and (Prop $response 'runId')) { $runId = $response.runId; $known[0].runId = $runId }
      $state = Read-Local (Join-Path $auditRunsRoot "$runId\state.json")
      return Json @{ response = $response; state = $state }
    }
  }
  if ($path -eq '/api/imports/prepare' -and $method -eq 'POST') {
    $body = Audit-Body $req
    $id = Check-ID $body.importId
    $target = Resolve-Target $body.path
    if ($target.Folder -ne (Join-Path $Root 'working')) { Fail 400 'imports require working JSON' }
    if ((Stamp $target.Path) -ne $body.expect) { Fail 409 'canonical changed before preparation' }
    $candidateBytes = $utf8.GetBytes($body.text)
    if ($candidateBytes.Length -gt 10MB) { Fail 413 'canonical exceeds limit' }
    $candidate = ConvertFrom-Json $body.text
    $batches = @($candidate.importBatches | Where-Object { $_.id -eq $id -and $_.state -eq 'applied' })
    if ($candidate.schemaVersion -ne 2 -or $candidate.documentId -notmatch '^doc_[a-zA-Z0-9]{16}$' -or $batches.Count -ne 1) { Fail 400 'invalid import candidate' }
    $batch = $batches[0]
    # An importId names one run, selection and sealed package: the same id with other content is refused.
    $run = @($auditRuns.Values | Where-Object { $_.runId -eq $batch.runId })
    if (-not $run.Count) { Fail 403 'import run is not open in this session' }
    if ($run[0].siteId -and $run[0].siteId -ne $body.siteId) { Fail 409 'import site differs from its run' }
    $same = { param($other) $other.runId -eq $batch.runId -and $other.selectionHash -eq $batch.selectionHash -and $other.packageHash -eq $batch.packageHash }
    if ($auditImports.ContainsKey($id) -and -not (& $same $auditImports[$id])) { Fail 409 'import identity content mismatch' }
    $recorded = @((Prop (ConvertFrom-Json $utf8.GetString((Read-Canonical $target.Path).Bytes)) 'importBatches' @()) | Where-Object { $_.id -eq $id })
    if ($recorded.Count -and -not (& $same $recorded[0])) { Fail 409 'import identity differs from the canonical record' }
    $hash = SHA $candidateBytes
    $requestId = Send-AuditRequest 'PrepareEvidence' @{ importId = $id; runId = $batch.runId; siteId = $body.siteId; candidateHash = $hash; intent = @{ documentId = $candidate.documentId; importId = $id; candidateHash = $hash; packageHash = $batch.packageHash; selectionHash = $batch.selectionHash; bindings = $batch.bindings } }
    $operation = @{ importId = $id; path = $body.path; expect = $body.expect; text = $body.text; candidateHash = $hash; documentId = $candidate.documentId; runId = $batch.runId; selectionHash = $batch.selectionHash; packageHash = $batch.packageHash; requestId = $requestId; verifyId = ''; state = 'preparing' }
    $script:auditImports[$id] = $operation
    Local-Json (Join-Path $auditIpc "imports\$id.json") $operation
    return Accepted @{ importId = $id }
  }
  if ($path -match '^/api/imports/([a-zA-Z0-9_-]{1,100})(/(verify|commit|reconcile))?$') {
    $id, $action = $Matches[1], $Matches[3]
    $operation = Import-State $id
    if ($method -eq 'GET' -and -not $action) {
      $response = Audit-Response $operation.requestId
      if ($operation.verifyId) { $response = Audit-Response $operation.verifyId }
      return Json @{ importId = $id; state = $operation.state; response = $response }
    }
    if ($method -eq 'POST' -and $action -eq 'verify') {
      $prepared = Audit-Response $operation.requestId
      if ($prepared.accepted -ne $true) { Fail 409 'evidence preparation incomplete' }
      if ($prepared.package.hash -ne $operation.packageHash) { Fail 409 'evidence package differs' }
      $operation.verifyId = Send-AuditRequest 'VerifyEvidence' @{ importId = $id; candidateHash = $operation.candidateHash }
      return Accepted @{ importId = $id }
    }
    if ($method -eq 'POST' -and $action -eq 'commit') {
      if (-not $operation.verifyId) { Fail 409 'fresh evidence verification required' }
      $verified = Audit-Response $operation.verifyId
      if ($verified.accepted -ne $true -or -not (Prop $verified 'proofJson')) { Fail 409 'verification pending or failed' }
      if ((HMAC $verified.proofJson) -ne $verified.signature) { Fail 403 'invalid evidence proof' }
      $proof = ConvertFrom-Json $verified.proofJson
      if ($proof.ownerEpoch -ne $auditEpoch -or $proof.importId -ne $id -or $proof.candidateHash -ne $operation.candidateHash -or $proof.packageHash -ne $operation.packageHash -or $proof.nonce -ne $auditRequests[$operation.verifyId].nonce -or $proof.expiresAt -lt (Epoch-Time)) { Fail 409 'evidence proof expired or differs' }
      $target = Resolve-Target $operation.path
      $stamp = Save-Canonical $target $utf8.GetBytes($operation.text) $operation.expect $true
      $operation.state = 'saved'
      try {
        Fault-Point 'receipt'
        Local-Json (Join-Path $auditIpc "imports\$id.json") $operation
      } catch { [Console]::Out.WriteLine('tylan: import receipt pending; canonical file is authoritative') }
      Fault-Point 'respond'
      return Json @{ lastModified = $stamp; text = $operation.text }
    }
    if ($method -eq 'GET' -and $action -eq 'reconcile') {
      $target = Resolve-Target $operation.path
      if (-not [System.IO.File]::Exists($target.Path)) { return Json @{ state = 'unknown' } }
      $file = Read-Canonical $target.Path
      $text = $utf8.GetString($file.Bytes)
      $document = ConvertFrom-Json $text
      if ($document.documentId -ne $operation.documentId) { return Json @{ state = 'conflict' } }
      $batch = @((Prop $document 'importBatches' @()) | Where-Object { $_.id -eq $id })
      return Json @{ state = $(if (-not $batch.Count) { 'notApplied' } elseif ($batch[0].packageHash -ne $operation.packageHash) { 'conflict' } else { $batch[0].state }); text = $text; lastModified = $file.Stamp }
    }
  }
  Fail 404 'unknown audit operation'
}
