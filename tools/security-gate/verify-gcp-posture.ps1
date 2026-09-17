param(
    [string]$ProjectId = "cwb-boat-operations-c50dd"
)

$ErrorActionPreference = "Stop"
$failures = [System.Collections.Generic.List[string]]::new()
$env:CLOUDSDK_METRICS_ENVIRONMENT = ((@($env:CLOUDSDK_METRICS_ENVIRONMENT, "datacloud.vscode") | Where-Object { $_ }) -join " ")

function Invoke-GcloudJson {
    param([string[]]$Arguments)
    $json = & gcloud @Arguments --project=$ProjectId --format=json 2>$null
    if ($LASTEXITCODE -ne 0) { throw "gcloud command failed: $($Arguments -join ' ')" }
    if (-not $json) { return @() }
    $parsed = ($json -join "`n") | ConvertFrom-Json
    Write-Output $parsed
}

$requiredApis = @(
    "cloudfunctions.googleapis.com",
    "cloudscheduler.googleapis.com",
    "firebaseappcheck.googleapis.com",
    "firestore.googleapis.com",
    "recaptchaenterprise.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "securitycenter.googleapis.com"
)
$enabledApis = @(Invoke-GcloudJson @("services", "list", "--enabled")) | ForEach-Object { $_.config.name }
foreach ($api in $requiredApis) {
    if ($api -notin $enabledApis) { $failures.Add("Required API is disabled: $api") }
}

$expectedRoles = @{
    "cwb-telemetry-ingest@$ProjectId.iam.gserviceaccount.com" = @("roles/datastore.user")
    "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" = @("roles/datastore.user", "roles/firebaseauth.admin")
    "cwb-boat-config@$ProjectId.iam.gserviceaccount.com" = @("roles/datastore.user")
}
$policy = Invoke-GcloudJson @("projects", "get-iam-policy", $ProjectId)
foreach ($identity in $expectedRoles.Keys) {
    $roles = @($policy.bindings | Where-Object { "serviceAccount:$identity" -in $_.members } | ForEach-Object { $_.role })
    foreach ($role in $expectedRoles[$identity]) {
        if ($role -notin $roles) { $failures.Add("$identity is missing $role") }
    }
    foreach ($role in $roles) {
        if ($role -notin $expectedRoles[$identity]) { $failures.Add("$identity has unexpected project role $role") }
    }
}

foreach ($defaultIdentity in @(
    "189840801017-compute@developer.gserviceaccount.com",
    "cwb-boat-operations-c50dd@appspot.gserviceaccount.com"
)) {
    $roles = @($policy.bindings | Where-Object { "serviceAccount:$defaultIdentity" -in $_.members } | ForEach-Object { $_.role })
    foreach ($broadRole in @("roles/owner", "roles/editor")) {
        if ($broadRole -in $roles) { $failures.Add("Default identity $defaultIdentity has broad role $broadRole") }
    }
}
$buildIdentity = "189840801017-compute@developer.gserviceaccount.com"
$buildRoles = @($policy.bindings | Where-Object { "serviceAccount:$buildIdentity" -in $_.members } | ForEach-Object { $_.role })
if ("roles/cloudbuild.builds.builder" -notin $buildRoles) {
    $failures.Add("Cloud Functions build identity is missing roles/cloudbuild.builds.builder")
}

$endpointPolicyPath = Join-Path $PSScriptRoot "gcp-endpoints.json"
$endpointPolicy = Get-Content -Raw $endpointPolicyPath | ConvertFrom-Json
$expectedFunctions = @{}
foreach ($endpoint in $endpointPolicy.endpoints) {
    $runtimeIdentity = switch ($endpoint.name) {
        "telemetryIngest" { "cwb-telemetry-ingest@$ProjectId.iam.gserviceaccount.com"; break }
        "purgeExpiredTrails" { "cwb-telemetry-ingest@$ProjectId.iam.gserviceaccount.com"; break }
        "pushBoatConfig" { "cwb-boat-config@$ProjectId.iam.gserviceaccount.com"; break }
        default { "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" }
    }
    $expectedFunctions[$endpoint.name] = $runtimeIdentity
}
$deployedFunctions = @(Invoke-GcloudJson @("functions", "list", "--v2", "--regions=us-west1"))
foreach ($function in $deployedFunctions) {
    $name = ($function.name -split "/")[-1]
    if (-not $expectedFunctions.ContainsKey($name)) { $failures.Add("Unexpected deployed function: $name") }
}
$functions = @()
foreach ($name in $expectedFunctions.Keys) {
    try {
        $function = Invoke-GcloudJson @("functions", "describe", $name, "--v2", "--region=us-west1")
        $functions += $function
    } catch {
        $failures.Add("Required function is missing: $name")
        continue
    }
    if ($function.state -ne "ACTIVE") { $failures.Add("Function $name is not ACTIVE") }
    if ($function.buildConfig.runtime -ne "nodejs22") { $failures.Add("Function $name is not running Node.js 22") }
    if ($function.serviceConfig.serviceAccountEmail -ne $expectedFunctions[$name]) {
        $failures.Add("Function $name uses unexpected runtime identity")
    }
}

$telemetry = $functions | Where-Object { ($_.name -split "/")[-1] -eq "telemetryIngest" }
$boatConfig = $functions | Where-Object { ($_.name -split "/")[-1] -eq "pushBoatConfig" }
$disableUser = $functions | Where-Object { ($_.name -split "/")[-1] -eq "disableUser" }
$deleteUser = $functions | Where-Object { ($_.name -split "/")[-1] -eq "deleteUser" }
$retryLifecycleNotifications = $functions | Where-Object { ($_.name -split "/")[-1] -eq "retryLifecycleNotifications" }
$secretBindings = @(
    @($telemetry, "CHIRPSTACK_WEBHOOK_TOKEN", "cwb-telemetry-ingest@$ProjectId.iam.gserviceaccount.com"),
    @($boatConfig, "CHIRPSTACK_API_TOKEN", "cwb-boat-config@$ProjectId.iam.gserviceaccount.com"),
    @($disableUser, "GMAIL_SENDER_EMAIL", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($disableUser, "GMAIL_APP_PASSWORD", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($disableUser, "LIFECYCLE_NOTIFICATION_KEY", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($deleteUser, "GMAIL_SENDER_EMAIL", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($deleteUser, "GMAIL_APP_PASSWORD", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($deleteUser, "LIFECYCLE_NOTIFICATION_KEY", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($retryLifecycleNotifications, "GMAIL_SENDER_EMAIL", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($retryLifecycleNotifications, "GMAIL_APP_PASSWORD", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com"),
    @($retryLifecycleNotifications, "LIFECYCLE_NOTIFICATION_KEY", "cwb-user-admin@$ProjectId.iam.gserviceaccount.com")
)

$schedulerJobs = @(Invoke-GcloudJson @("scheduler", "jobs", "list", "--location=us-west1"))
$expectedSchedules = @(
    @{ Name = "purgeExpiredTrails"; Schedule = "every 6 hours"; Identity = "cwb-telemetry-ingest@$ProjectId.iam.gserviceaccount.com" },
    @{ Name = "purgeExpiredInvitations"; Schedule = "every 6 hours"; Identity = "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" },
    @{ Name = "purgeExpiredBatteryEvents"; Schedule = "every 24 hours"; Identity = "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" },
    @{ Name = "retryLifecycleNotifications"; Schedule = "every 15 minutes"; Identity = "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" },
    @{ Name = "reconcileIdentityState"; Schedule = "every 1 hours"; Identity = "cwb-user-admin@$ProjectId.iam.gserviceaccount.com" }
)
foreach ($expectedSchedule in $expectedSchedules) {
    $job = $schedulerJobs | Where-Object { $_.name -match $expectedSchedule.Name }
    if (-not $job) {
        $failures.Add("Scheduled function is missing: $($expectedSchedule.Name)")
        continue
    }
    if ($job.state -ne "ENABLED") { $failures.Add("Scheduled function is not enabled: $($expectedSchedule.Name)") }
    if ($job.schedule -ne $expectedSchedule.Schedule) { $failures.Add("Scheduled function has an unexpected schedule: $($expectedSchedule.Name)") }
    if ($job.httpTarget.httpMethod -ne "POST" -or $job.httpTarget.uri -notmatch $expectedSchedule.Name) {
        $failures.Add("Scheduled function has an unexpected target: $($expectedSchedule.Name)")
    }
    if ($job.httpTarget.oidcToken.serviceAccountEmail -ne $expectedSchedule.Identity) {
        $failures.Add("Scheduled function uses an unexpected identity: $($expectedSchedule.Name)")
    }
}

foreach ($binding in $secretBindings) {
    $function = $binding[0]
    $secret = $binding[1]
    $expectedIdentity = $binding[2]
    $environmentBinding = $function.serviceConfig.secretEnvironmentVariables | Where-Object { $_.secret -eq $secret }
    if (-not $environmentBinding) {
        $failures.Add("Function is not bound to $secret")
        continue
    }

    $version = Invoke-GcloudJson @("secrets", "versions", "describe", $environmentBinding.version, "--secret=$secret")
    if ($version.state -ne "ENABLED") { $failures.Add("Function-bound version of $secret is not enabled") }

    $secretPolicy = Invoke-GcloudJson @("secrets", "get-iam-policy", $secret)
    $accessors = @($secretPolicy.bindings |
        Where-Object { $_.role -eq "roles/secretmanager.secretAccessor" } |
        ForEach-Object { $_.members })
    $expectedMember = "serviceAccount:$expectedIdentity"
    if ($expectedMember -notin $accessors) { $failures.Add("$secret does not grant access to its consuming runtime identity") }
    foreach ($member in $accessors) {
        if ($member -ne $expectedMember) { $failures.Add("$secret grants access to an unexpected principal") }
    }
}

$auditTypes = @($policy.auditConfigs | ForEach-Object { $_.auditLogConfigs.logType })
foreach ($type in @("DATA_READ", "DATA_WRITE")) {
    if ($type -notin $auditTypes) { $failures.Add("Project audit logging is missing $type") }
}

$metricNames = @(Invoke-GcloudJson @("logging", "metrics", "list")) | ForEach-Object { $_.name }
foreach ($metric in @("cwb_webhook_rejections", "cwb_callable_auth_denials", "cwb_unknown_devices", "cwb_retention_failures", "cwb_identity_state_mismatches", "cwb_forced_session_exits")) {
    if ($metric -notin $metricNames) { $failures.Add("Security log metric is missing: $metric") }
}

$policies = @(Invoke-GcloudJson @("monitoring", "policies", "list"))
foreach ($name in @("CWB Security Signals", "CWB Security Control Changes")) {
    if (-not ($policies | Where-Object { $_.displayName -eq $name -and $_.enabled -ne $false })) {
        $failures.Add("Enabled alert policy is missing: $name")
    }
}

$auditBucket = Invoke-GcloudJson @("logging", "buckets", "describe", "cwb-security-audit", "--location=us-west1")
if ($auditBucket.retentionDays -lt 365) { $failures.Add("Security audit log retention is less than 365 days") }
$auditSinks = @(Invoke-GcloudJson @("logging", "sinks", "list"))
if (-not ($auditSinks | Where-Object { $_.name -eq "cwb-security-audit-sink" })) {
    $failures.Add("Security audit log sink is missing")
}

$recaptchaKeys = @(Invoke-GcloudJson @("recaptcha", "keys", "list"))
if (-not ($recaptchaKeys | Where-Object { $_.displayName -eq "CWB Firebase App Check" })) {
    $failures.Add("CWB reCAPTCHA Enterprise App Check key is missing")
}

$accessToken = & gcloud auth print-access-token 2>$null
if ($LASTEXITCODE -ne 0 -or -not $accessToken) { throw "Unable to obtain access token for App Check verification" }
$headers = @{ Authorization = "Bearer $accessToken"; "x-goog-user-project" = $ProjectId }
$appCheck = Invoke-RestMethod -Uri "https://firebaseappcheck.googleapis.com/v1/projects/189840801017/services/firestore.googleapis.com" -Headers $headers
if ($appCheck.enforcementMode -ne "ENFORCED") { $failures.Add("Firestore App Check enforcement is not enabled") }
$provider = Invoke-RestMethod -Uri "https://firebaseappcheck.googleapis.com/v1/projects/189840801017/apps/1%3A189840801017%3Aweb%3A4c0f1515024afdbb05b628/recaptchaEnterpriseConfig" -Headers $headers
if (-not $provider.siteKey) { $failures.Add("Firebase web app has no reCAPTCHA Enterprise App Check provider") }

if ($failures.Count) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Output "GCP security posture verified for $ProjectId."