# Build a minimal JRE using jlink from the system-installed JDK.
# Output: <project-root>/jre/  (consumed by electron-builder extraResources)
#
# Modules chosen to cover the runtime needs of TVBox spider JARs:
#   java.base          - core JDK (String, IO, threads, etc.)
#   java.logging       - java.util.logging used by OkHttp
#   java.naming        - JNDI (some spider code paths)
#   java.net.http      - HttpClient
#   java.scripting     - javax.script (Nashorn-like eval)
#   java.sql           - JDBC (some spiders use java.sql types)
#   java.xml           - SAX/DOM parsers
#   jdk.crypto.cryptoki - PKCS#11/JCE provider (BouncyCastle fallback)
#   jdk.crypto.ec      - EC curves for TLS
#   jdk.unsupported    - sun.misc.Unsafe used by Gson/Kotlin
#   jdk.management     - java.lang.management.ManagementFactory
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/build-jre.ps1
# Or via: pnpm build:jre

$ErrorActionPreference = 'Stop'

$JdkHome = $env:JAVA_HOME
if (-not $JdkHome -or -not (Test-Path $JdkHome)) {
    $JdkHome = 'C:\Program Files\Java\jdk-21.0.10'
}
if (-not (Test-Path $JdkHome)) {
    throw "JDK not found. Set JAVA_HOME or install JDK 21+ to C:\Program Files\Java\jdk-21.0.10"
}

$jlink = Join-Path $JdkHome 'bin\jlink.exe'
$jmods = Join-Path $JdkHome 'jmods'
if (-not (Test-Path $jlink)) { throw "jlink.exe not found at $jlink" }
if (-not (Test-Path $jmods)) { throw "jmods directory not found at $jmods" }

$projectRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $projectRoot 'jre'

if (Test-Path $outDir) {
    Write-Host "Removing existing JRE at $outDir"
    Remove-Item -Recurse -Force $outDir
}

Write-Host "Building minimal JRE to $outDir"
Write-Host "  JDK home: $JdkHome"
Write-Host "  jlink:    $jlink"

& $jlink `
    --module-path $jmods `
    --add-modules java.base,java.logging,java.naming,java.net.http,java.scripting,java.sql,java.xml,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.unsupported,jdk.management,jdk.zipfs `
    --output $outDir `
    --no-header-files `
    --no-man-pages `
    --compress=2

if ($LASTEXITCODE -ne 0) {
    throw "jlink failed with exit code $LASTEXITCODE"
}

$size = (Get-ChildItem $outDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$sizeMB = [math]::Round($size / 1MB, 1)
Write-Host "JRE built successfully. Size: $sizeMB MB"

$jvmDll = Join-Path $outDir 'bin\server\jvm.dll'
if (Test-Path $jvmDll) {
    $jvmSize = [math]::Round((Get-Item $jvmDll).Length / 1MB, 1)
    Write-Host "jvm.dll: $jvmSize MB at $jvmDll"
}
else {
    throw "jvm.dll not found at $jvmDll"
}
