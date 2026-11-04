# Simple static file server for Windows PowerShell (no installs required)
# Usage: powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 5500 -Root .\web

param(
  [int]$Port = 5500,
  [string]$Root = "web"
)

$ErrorActionPreference = 'Stop'
$rootPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Root))
if (-not (Test-Path $rootPath)) { throw "Root path not found: $rootPath" }

Add-Type -AssemblyName System.Net
Add-Type -AssemblyName System.IO

$mime = @{ 
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8';
  '.js'='application/javascript; charset=utf-8'; '.mjs'='application/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8';
  '.webmanifest'='application/manifest+json; charset=utf-8'; '.txt'='text/plain; charset=utf-8';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.svg'='image/svg+xml'
}

$listener = [System.Net.HttpListener]::new()
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving $rootPath at $prefix (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $path = $req.Url.AbsolutePath.TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
      $full = Join-Path $rootPath $path
      if (-not (Test-Path $full)) {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $res.OutputStream.Write($bytes,0,$bytes.Length)
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $ctype = $mime[$ext]
        if (-not $ctype) { $ctype = 'application/octet-stream' }
        $res.Headers['Content-Type'] = $ctype
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes,0,$bytes.Length)
      }
    } catch {
      $res.StatusCode = 500
      $msg = [System.Text.Encoding]::UTF8.GetBytes($_.ToString())
      $res.OutputStream.Write($msg,0,$msg.Length)
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}




