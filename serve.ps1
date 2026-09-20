<#
.SYNOPSIS
    Minimal static file server for this project, using nothing but Windows.

.DESCRIPTION
    The browser blocks `fetch` on file:// URLs, so the data files in data/ can
    only be loaded over HTTP. Normally `python serve.py` would do, but there is
    no Python or Node on the PATH on this machine, so this uses
    System.Net.HttpListener, which ships with Windows PowerShell.

    It binds to localhost only, which is the one prefix Windows lets a
    non-elevated process listen on.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File serve.ps1
    powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 9000 -NoBrowser
#>
param(
    [int]$Port = 8000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "Could not listen on $prefix" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor DarkGray
    exit 1
}

Write-Host "Towers running at $prefix" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

if (-not $NoBrowser) {
    Start-Process $prefix
}

while ($listener.IsListening) {
    $context = $null
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }

    $request = $context.Request
    $response = $context.Response

    try {
        $relative = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }

        $resolved = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

        # Keep the server inside the project folder.
        if (-not $resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $response.StatusCode = 403
        } elseif (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            $response.StatusCode = 404
        } else {
            $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
            $response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            # No caching: the point of this server is iterating on the game, and a
            # stale module costs more time than a slightly slower load.
            $response.Headers.Add('Cache-Control', 'no-store, must-revalidate')

            $bytes = [System.IO.File]::ReadAllBytes($resolved)
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
    } catch {
        try { $response.StatusCode = 500 } catch { }
    } finally {
        try { $response.Close() } catch { }
    }
}
