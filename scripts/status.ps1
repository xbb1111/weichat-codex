$ErrorActionPreference = 'Stop'

$TaskName = 'weichat-codex'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) {
  Write-Host "Scheduled task not found: $TaskName"
  exit 0
}

$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[PSCustomObject]@{
  TaskName = $TaskName
  State = $Task.State
  LastRunTime = $Info.LastRunTime
  LastTaskResult = $Info.LastTaskResult
  NextRunTime = $Info.NextRunTime
} | Format-List
