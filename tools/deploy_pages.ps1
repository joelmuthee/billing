# Deploys billing.essenceautomations.com (Cloudflare Pages project "billing") with ONLY the
# front-end files. Never `wrangler pages deploy .` here: that publishes everything in the folder,
# NOTES.md, BUILD-PLAYBOOK.md and the Worker source included, and it ignores .gitignore.
#
#   powershell -File tools\deploy_pages.ps1
#
# Then deploy the CRM too if app.js / index.html / styles.css changed: its Clients and Billing
# tabs are built from these files (Sales Manager/agency: node tools/build_billing.mjs).

$ErrorActionPreference = 'Stop'
$env:CLOUDFLARE_ACCOUNT_ID = '58685495706b973821d77208248c66fc'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $env:TEMP ("billing-dist-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

New-Item -ItemType Directory -Force $dist | Out-Null
foreach ($f in @('index.html', 'app.js', 'styles.css', 'favicon.svg', '_headers')) {
  Copy-Item (Join-Path $root $f) $dist
}
Copy-Item (Join-Path $root 'assets') (Join-Path $dist 'assets') -Recurse

try {
  Push-Location $root
  npx --yes wrangler@4.118.0 pages deploy $dist --project-name=billing --branch=master --commit-dirty=true
} finally {
  Pop-Location
  Remove-Item $dist -Recurse -Force
}

# Prove nothing private is served: these must come back as the page itself, not the file.
foreach ($f in @('NOTES.md', 'worker/src/index.js', '.env')) {
  $body = (Invoke-WebRequest -UseBasicParsing "https://billing.essenceautomations.com/$f").Content
  if ($body -notmatch '^\s*<!DOCTYPE html') { throw "$f is being served as a file. Stop and check the deploy." }
}
Write-Host "Deployed. NOTES.md, the Worker source and .env are not served."
