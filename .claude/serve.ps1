# Minimal static file server for the rsc-designer preview (no Python/Node on this machine)
$root = Join-Path $PSScriptRoot "..\rsc-designer" | Resolve-Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8321/")
$listener.Start()
Write-Host "Serving $root at http://localhost:8321/"
$mime = @{ ".html"="text/html"; ".htm"="text/html"; ".js"="text/javascript"; ".css"="text/css";
           ".svg"="image/svg+xml"; ".png"="image/png"; ".jpg"="image/jpeg"; ".json"="application/json" }
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
    $file = Join-Path $root $rel
    $full = [IO.Path]::GetFullPath($file)
    if ($full.StartsWith($root.Path) -and (Test-Path $full -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($full)
      $ext = [IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch { }
}
