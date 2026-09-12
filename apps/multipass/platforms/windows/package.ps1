param(
    [string]$Runtime = "win-x64",
    [string]$EnginePath = "",
    [string]$Output = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (!$Output) { $Output = Join-Path $root "dist/windows-$Runtime" }
if (!$EnginePath) {
    Push-Location $root
    try {
        & cargo build --locked --release --package multipass-core --bin multipass-engine
        if ($LASTEXITCODE -ne 0) { throw "Rust engine build failed" }
    } finally { Pop-Location }
    $EnginePath = Join-Path $root "target/release/multipass-engine.exe"
}
if (!(Test-Path -LiteralPath $EnginePath -PathType Leaf)) { throw "Engine executable not found: $EnginePath" }
& dotnet publish (Join-Path $PSScriptRoot "Multipass.Windows.csproj") -c Release -r $Runtime --self-contained true -o $Output
if ($LASTEXITCODE -ne 0) { throw "Native UI build failed" }
Copy-Item -LiteralPath $EnginePath -Destination (Join-Path $Output "multipass-engine.exe")
Write-Output "Package created in $Output. Run Multipass.exe."
