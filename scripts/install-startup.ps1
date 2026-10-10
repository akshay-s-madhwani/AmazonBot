$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe).Source
$pm2Cli = Join-Path (Split-Path -Parent (Get-Command pm2.cmd).Source) 'node_modules\pm2\bin\pm2'
if (-not (Test-Path -LiteralPath $pm2Cli)) { throw 'Install PM2 first.' }

# Webhook configuration is mandatory: setup must never silently skip the receiver.
$envFile = Join-Path $repoRoot 'deploy.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot 'deploy.env.example') -Destination $envFile
}
$config = Get-Content -LiteralPath $envFile -Raw
function Read-Setting([string]$name) {
    $match = [regex]::Match($config, '(?m)^' + [regex]::Escape($name) + '=(.*)$')
    return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
}
function Set-Setting([string]$name, [string]$value) {
    if ($value -match '[\r\n"''#]') { throw "Unsupported characters in $name" }
    $line = $name + '=' + $value
    $pattern = '(?m)^' + [regex]::Escape($name) + '=.*$'
    if ([regex]::IsMatch($script:config, $pattern)) {
        $script:config = [regex]::Replace($script:config, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
    } else { $script:config += "`r`n$line`r`n" }
}
if ((Read-Setting 'DEPLOY_SECRET').Length -lt 32) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    Set-Setting 'DEPLOY_SECRET' ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
}
if (-not (Read-Setting 'DEPLOY_GITHUB_TOKEN')) {
    $secureToken = Read-Host 'GitHub token with Actions read access to this repo' -AsSecureString
    $token = [System.Net.NetworkCredential]::new('', $secureToken).Password
    if (-not $token) { throw 'A GitHub token is required to configure the webhook.' }
    Set-Setting 'DEPLOY_GITHUB_TOKEN' $token
}
if ((Read-Setting 'DEPLOY_REPOSITORY') -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid DEPLOY_REPOSITORY in deploy.env.' }
foreach ($name in @('DEPLOY_PORT', 'DEPLOY_MANAGER_PORT')) {
    $port = 0
    if (-not [int]::TryParse((Read-Setting $name), [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw "Invalid $name in deploy.env." }
}
[IO.File]::WriteAllText($envFile, $config, [Text.UTF8Encoding]::new($false))
Write-Host 'Webhook configured in deploy.env. Add its DEPLOY_SECRET to the pipeline target secret.'
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument ('"' + $pm2Cli + '" resurrect') -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'AmazonBot-PM2' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host 'PM2 will restore this user''s saved processes at Windows sign-in.'
