$ErrorActionPreference = 'Stop'
# Never select ordinary Chrome windows by image name alone.
$browserProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'chrome.exe' -and (
        $_.ExecutablePath -match '(?i)shardx' -or
        $_.CommandLine -match '--fleet-bot-browser|--user-data-dir=.*(?:browser-profiles|shardx-profiles)'
    )
})
$browserIds = @($browserProcesses | ForEach-Object { $_.ProcessId })
$browserProcesses | Where-Object { $_.ParentProcessId -notin $browserIds } |
    ForEach-Object { $_.ProcessId }
