# tylan launcher: serves editor.html on 127.0.0.1 and does the file I/O on the tylan folder for it.
# Edge cannot write to SMB shares through the File System Access API, so this process writes instead.
# Safety: loopback only, a random token per launch, Host/Origin checks, a fixed set of sub folders,
# and stops by itself a few minutes after the editor window is closed.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
param(
  [string]$Root = '',
  [switch]$NoBrowser,
  [int]$IdleMinutes = 3,
  [string]$CollectorRoot = '',
  [string]$AuditFixture = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# tylan.cmd runs this hidden, so a fatal error must be shown in a dialog instead of a console.
trap {
  $text = "tylan could not start or stopped with an error.`n`n$($_.Exception.Message)"
  if ($NoBrowser) {
    [Console]::Error.WriteLine($text)
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, 'tylan', 'OK', 'Error')
  }
  exit 1
}

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).ProviderPath
$editor = Join-Path $PSScriptRoot 'editor.html'
if (-not (Test-Path -LiteralPath $editor)) { throw "editor.html not found next to tylan.ps1: $editor" }
$dirs = @{ 'working' = 'working'; 'working/csv' = 'working\csv'; 'published' = 'published'; 'archive' = 'archive' }
$exts = @('.json', '.html', '.csv')
$maxBody = 32MB
$utf8 = New-Object System.Text.UTF8Encoding($false)

$random = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
$token = -join ($random | ForEach-Object { $_.ToString('x2') })
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$origin = "http://127.0.0.1:$port"
$url = "$origin/?t=$token"

function Fail([int]$status, [string]$message) {
  $e = New-Object System.Exception $message
  $e.Data['status'] = $status
  throw $e
}
function Reply([int]$status, [string]$type, [byte[]]$bytes, $headers = @{}) {
  @{ Status = $status; Type = $type; Bytes = $bytes; Headers = $headers }
}
function Json($value) {
  Reply 200 'application/json; charset=utf-8' $utf8.GetBytes((ConvertTo-Json -InputObject $value -Depth 64 -Compress))
}
function SHA([byte[]]$bytes) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($hash.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $hash.Dispose() }
}
# One consistent read: the bytes and their stamp describe the same version, and writers are
# excluded while reading. A file that keeps changing is reported busy (409), never torn.
function Read-Canonical([string]$path) {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $before = [System.IO.File]::GetLastWriteTimeUtc($path).Ticks
      $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
      try {
        $bytes = New-Object byte[] $stream.Length
        $read = 0
        while ($read -lt $bytes.Length) {
          $n = $stream.Read($bytes, $read, $bytes.Length - $read)
          if ($n -le 0) { break }
          $read += $n
        }
      } finally { $stream.Dispose() }
      if ($read -eq $bytes.Length -and [System.IO.File]::GetLastWriteTimeUtc($path).Ticks -eq $before) {
        return @{ Bytes = $bytes; Stamp = $before.ToString() + ':' + (SHA $bytes) }
      }
    } catch [System.IO.IOException] { }
    Start-Sleep -Milliseconds 25
  }
  Fail 409 'file is being changed elsewhere; try again'
}
function Stamp([string]$path) { (Read-Canonical $path).Stamp }
# Offline acceptance tests only (-AuditFixture): fail one named share boundary once.
$script:faultPoint = ''
function Fault-Point([string]$name) {
  if ($script:faultPoint -eq $name) {
    $script:faultPoint = ''
    Fail 500 "injected fault: $name"
  }
}
function Resolve-Target($rel) {
  $rel = [string]$rel
  $i = $rel.LastIndexOf('/')
  if ($i -lt 1) { Fail 400 'path must be <folder>/<file>' }
  $dir = $rel.Substring(0, $i)
  $name = $rel.Substring($i + 1)
  if (-not $dirs.ContainsKey($dir)) { Fail 400 "folder not allowed: $dir" }
  if ($name -notmatch '^[^\\/:*?"<>|\x00-\x1f]+$' -or $name.StartsWith('.') -or $name.EndsWith('.') -or $name.EndsWith(' ')) {
    Fail 400 "bad file name: $name"
  }
  if ($exts -notcontains [System.IO.Path]::GetExtension($name).ToLowerInvariant()) { Fail 400 "file type not allowed: $name" }
  $folder = Join-Path $Root $dirs[$dir]
  if (Test-Path -LiteralPath $folder) {
    if ((Get-Item -LiteralPath $folder).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Fail 400 'reparse folder prohibited' }
  }
  $resolved = Join-Path $folder $name
  if ((Test-Path -LiteralPath $resolved) -and ((Get-Item -LiteralPath $resolved).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Fail 400 'reparse file prohibited' }
  @{ Folder = $folder; Path = $resolved }
}
function Save-Canonical($target, [byte[]]$bytes, [string]$expect, [bool]$importing = $false) {
  $exists = [System.IO.File]::Exists($target.Path)
  $before = if ($exists) { Stamp $target.Path } else { 'new' }
  if (($expect -eq 'new' -and $exists) -or ($expect -notin @('new', 'any') -and $expect -ne $before)) { Fail 409 'changed elsewhere' }
  if ([System.IO.Path]::GetExtension($target.Path) -eq '.json' -and $target.Folder -eq (Join-Path $Root 'working')) {
    if ($bytes.Length -gt 10MB) { Fail 413 'canonical JSON exceeds 10MiB' }
    $candidate = ConvertFrom-Json $utf8.GetString($bytes)
    if ((Prop $candidate 'schemaVersion') -eq 2 -and $exists -and -not $importing) {
      $previous = ConvertFrom-Json $utf8.GetString((Read-Canonical $target.Path).Bytes)
      $oldBatches = @(Prop $previous 'importBatches' @())
      foreach ($batch in @(Prop $candidate 'importBatches' @())) {
        $old = @($oldBatches | Where-Object { $_.id -eq $batch.id })
        if (-not $old.Count) { Fail 409 'new imports require evidence prepare/commit' }
        if ($batch.state -eq 'applied' -and $old[0].state -ne 'applied') { Fail 409 'reapply imports through prepare/commit' }
      }
    }
  }
  [void][System.IO.Directory]::CreateDirectory($target.Folder)
  Fault-Point 'write'
  $tmp = "$($target.Path).$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllBytes($tmp, $bytes)
  # Keep a failed candidate for diagnosis. Never copy over a canonical file on replace failure.
  try {
    if ((SHA ([System.IO.File]::ReadAllBytes($tmp))) -ne (SHA $bytes)) { Fail 500 'temporary verification failed' }
    $current = if ([System.IO.File]::Exists($target.Path)) { Stamp $target.Path } else { 'new' }
    if ($current -ne $before) { Fail 409 'changed during save preparation' }
    Fault-Point 'replace'
    if ([System.IO.File]::Exists($target.Path)) {
      $archive = Join-Path $Root 'archive'
      [void][System.IO.Directory]::CreateDirectory($archive)
      $backup = Join-Path $archive ("previous-$([guid]::NewGuid().ToString('N'))" + [System.IO.Path]::GetExtension($target.Path))
      [System.IO.File]::Replace($tmp, $target.Path, $backup)
    } else {
      [System.IO.File]::Move($tmp, $target.Path)
    }
    $saved = Read-Canonical $target.Path
    if ((SHA $saved.Bytes) -ne (SHA $bytes)) { Fail 503 'saveUnknown: canonical verification differs' }
    return $saved.Stamp
  } catch { throw }
}

. (Join-Path $PSScriptRoot 'audit.ps1')

function Read-Request($stream) {
  $head = New-Object System.Collections.Generic.List[byte]
  $one = New-Object byte[] 1
  while ($true) {
    if ($stream.Read($one, 0, 1) -le 0) { return $null }
    $head.Add($one[0])
    $c = $head.Count
    if ($c -ge 4 -and $head[$c - 4] -eq 13 -and $head[$c - 3] -eq 10 -and $head[$c - 2] -eq 13 -and $head[$c - 1] -eq 10) { break }
    if ($c -gt 16384) { Fail 431 'headers too large' }
  }
  $lines = [System.Text.Encoding]::ASCII.GetString($head.ToArray()) -split "`r`n"
  $first = $lines[0] -split ' '
  if ($first.Count -lt 2) { Fail 400 'bad request line' }
  $headers = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $k = $line.IndexOf(':')
    if ($k -gt 0) { $headers[$line.Substring(0, $k).Trim().ToLowerInvariant()] = $line.Substring($k + 1).Trim() }
  }
  $target = $first[1]
  $q = $target.IndexOf('?')
  $path = if ($q -ge 0) { $target.Substring(0, $q) } else { $target }
  $query = @{}
  if ($q -ge 0) {
    foreach ($pair in $target.Substring($q + 1) -split '&') {
      if (-not $pair) { continue }
      $kv = $pair -split '=', 2
      $value = if ($kv.Count -gt 1) { $kv[1] } else { '' }
      $query[[System.Uri]::UnescapeDataString($kv[0].Replace('+', ' '))] = [System.Uri]::UnescapeDataString($value.Replace('+', ' '))
    }
  }
  $length = 0
  if ($headers.ContainsKey('content-length')) { $length = [int64]$headers['content-length'] }
  if ($length -gt $maxBody) { Fail 413 'request too large' }
  $body = New-Object byte[] $length
  $read = 0
  while ($read -lt $length) {
    $n = $stream.Read($body, $read, $length - $read)
    if ($n -le 0) { Fail 400 'request body ended early' }
    $read += $n
  }
  @{ Method = $first[0]; Path = $path; Query = $query; Headers = $headers; Body = $body }
}

function Route($req) {
  # Host check defeats DNS rebinding; Origin check defeats other sites posting to this port.
  if ($req.Headers['host'] -ne "127.0.0.1:$port") { Fail 403 'bad host' }
  $o = $req.Headers['origin']
  if ($o -and $o -ne $origin) { Fail 403 'bad origin' }
  if ($req.Path -eq '/') {
    if ($req.Method -ne 'GET' -or $req.Query['t'] -ne $token) { Fail 403 'start the editor from tools\tylan.cmd' }
    return Reply 200 'text/html; charset=utf-8' ([System.IO.File]::ReadAllBytes($editor))
  }
  if ($req.Headers['x-tylan-token'] -ne $token) { Fail 403 'missing token' }
  if ($AuditFixture -and $req.Method -eq 'POST' -and $req.Path -eq '/api/test/fault') {
    $script:faultPoint = [string]$req.Query['point']
    return Reply 204 'text/plain' (New-Object byte[] 0)
  }
  if ($req.Path.StartsWith('/api/audit/') -or $req.Path.StartsWith('/api/imports')) { return Route-Audit $req }
  switch ("$($req.Method) $($req.Path)") {
    'GET /api/info' { return Json ([ordered]@{ root = $Root; audit = (Audit-Info) }) }
    'POST /api/ping' { return Reply 204 'text/plain' (New-Object byte[] 0) }
    'GET /api/list' {
      $dir = [string]$req.Query['dir']
      if (-not $dirs.ContainsKey($dir)) { Fail 400 "folder not allowed: $dir" }
      $folder = Join-Path $Root $dirs[$dir]
      [void][System.IO.Directory]::CreateDirectory($folder)
      $items = @(Get-ChildItem -LiteralPath $folder -File |
          Where-Object { $exts -contains $_.Extension.ToLowerInvariant() } |
          ForEach-Object { [ordered]@{ name = $_.Name; lastModified = $_.LastWriteTimeUtc.Ticks.ToString() } })
      return Json $items
    }
    'GET /api/file' {
      $t = Resolve-Target $req.Query['path']
      if (-not [System.IO.File]::Exists($t.Path)) { Fail 404 'not found' }
      $file = Read-Canonical $t.Path
      return Reply 200 'text/plain; charset=utf-8' $file.Bytes @{ 'X-Last-Modified' = $file.Stamp }
    }
    'PUT /api/file' {
      # expect: the lastModified the editor last saw, 'new' (must not exist) or 'any' (overwrite).
      $t = Resolve-Target $req.Query['path']
      $expect = [string]$req.Query['expect']
      $exists = [System.IO.File]::Exists($t.Path)
      if ($expect -eq 'new') {
        if ($exists) { Fail 409 'already exists' }
      } elseif ($expect -ne 'any') {
        if (-not $exists -or (Stamp $t.Path) -ne $expect) { Fail 409 'changed elsewhere' }
      }
      $stamp = Save-Canonical $t $req.Body $expect
      return Json ([ordered]@{ lastModified = $stamp })
    }
    'POST /api/copy' {
      $from = Resolve-Target $req.Query['from']
      $to = Resolve-Target $req.Query['to']
      if (-not [System.IO.File]::Exists($from.Path)) { Fail 404 'not found' }
      if ([System.IO.File]::Exists($to.Path)) { Fail 409 'already exists' }
      [void][System.IO.Directory]::CreateDirectory($to.Folder)
      [System.IO.File]::Copy($from.Path, $to.Path, $false)
      return Reply 204 'text/plain' (New-Object byte[] 0)
    }
  }
  Fail 404 'not found'
}

function Send($stream, $res) {
  $reasons = @{ 200 = 'OK'; 202 = 'Accepted'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 409 = 'Conflict'; 413 = 'Payload Too Large'; 431 = 'Request Header Fields Too Large'; 500 = 'Internal Server Error'; 503 = 'Service Unavailable' }
  $reason = $reasons[[int]$res.Status]
  if (-not $reason) { $reason = 'Error' }
  $bytes = [byte[]]$res.Bytes
  $text = "HTTP/1.1 $($res.Status) $reason`r`nContent-Type: $($res.Type)`r`nContent-Length: $($bytes.Length)`r`n" +
    "Cache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n"
  foreach ($k in $res.Headers.Keys) { $text += "${k}: $($res.Headers[$k])`r`n" }
  $head = [System.Text.Encoding]::ASCII.GetBytes("$text`r`n")
  $stream.Write($head, 0, $head.Length)
  if ($bytes.Length) { $stream.Write($bytes, 0, $bytes.Length) }
}

function Serve($client) {
  $stream = $client.GetStream()
  $stream.ReadTimeout = 15000
  $stream.WriteTimeout = 15000
  try {
    $req = Read-Request $stream
    if ($null -eq $req) { return }
    $res = Route $req
  } catch {
    $status = $_.Exception.Data['status']
    if (-not $status) { $status = 500 }
    $res = Reply $status 'text/plain; charset=utf-8' $utf8.GetBytes($_.Exception.Message)
  }
  Send $stream $res
}

[Console]::Out.WriteLine("tylan: editing $Root")
[Console]::Out.WriteLine('tylan: stops by itself a few minutes after the editor is closed.')
[Console]::Out.WriteLine("TYLAN_URL=$url")
[Console]::Out.Flush()
if (-not $NoBrowser) {
  try { Start-Process 'msedge.exe' "--app=$url" } catch { Start-Process $url }
}
$last = Get-Date
try {
  while ($true) {
    Update-AuditLease
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 50
      if (((Get-Date) - $last).TotalMinutes -ge $IdleMinutes) {
        [Console]::Out.WriteLine('tylan: editor closed; stopping.')
        break
      }
      continue
    }
    $client = $listener.AcceptTcpClient()
    $last = Get-Date
    try { Serve $client } catch { [Console]::Out.WriteLine("tylan: $($_.Exception.Message)") } finally { $client.Close() }
  }
} finally {
  $listener.Stop()
}
