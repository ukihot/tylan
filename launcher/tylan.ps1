# tylan launcher: serves editor.html on 127.0.0.1 and does the file I/O on the tylan folder for it.
# Edge cannot write to SMB shares through the File System Access API, so this process writes instead.
# Safety: loopback only, a random token per launch, Host/Origin checks, a fixed set of sub folders,
# and stops by itself a few minutes after the editor window is closed.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
param(
  [string]$Root = '',
  [switch]$NoBrowser,
  [int]$IdleMinutes = 3
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
  Reply 200 'application/json; charset=utf-8' $utf8.GetBytes((ConvertTo-Json -InputObject $value -Depth 4 -Compress))
}
function Stamp([string]$path) { [System.IO.File]::GetLastWriteTimeUtc($path).Ticks.ToString() }
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
  @{ Folder = $folder; Path = (Join-Path $folder $name) }
}
function Write-Atomic($target, [byte[]]$bytes) {
  [void][System.IO.Directory]::CreateDirectory($target.Folder)
  $tmp = "$($target.Path).$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllBytes($tmp, $bytes)
  try {
    if ([System.IO.File]::Exists($target.Path)) {
      try { [System.IO.File]::Replace($tmp, $target.Path, [NullString]::Value) }
      catch { [System.IO.File]::Copy($tmp, $target.Path, $true) }
    } else {
      [System.IO.File]::Move($tmp, $target.Path)
    }
  } finally {
    if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
  }
}

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
  switch ("$($req.Method) $($req.Path)") {
    'GET /api/info' { return Json ([ordered]@{ root = $Root }) }
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
      return Reply 200 'text/plain; charset=utf-8' ([System.IO.File]::ReadAllBytes($t.Path)) @{ 'X-Last-Modified' = (Stamp $t.Path) }
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
      Write-Atomic $t $req.Body
      return Json ([ordered]@{ lastModified = (Stamp $t.Path) })
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
  $reasons = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 409 = 'Conflict'; 413 = 'Payload Too Large'; 431 = 'Request Header Fields Too Large'; 500 = 'Internal Server Error' }
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
