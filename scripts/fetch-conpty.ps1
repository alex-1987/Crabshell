# Downloads Microsoft's ConPTY (conpty.dll + OpenConsole.exe, MIT) for the Windows build.
#
# portable-pty prefers a conpty.dll next to crabshell.exe over the one built into Windows,
# which is much slower for PowerShell (src-tauri/tauri.windows.conf.json bundles both files).
# Run this once before `npm run tauri build` on Windows; the release workflow runs it too.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-conpty.ps1

$ErrorActionPreference = 'Stop'

# Pinned: update the version and the SHA256 of the .nupkg together.
$Version = '1.25.261109001'
$Sha256 = '3d77f535df848e44225c2a8912ac844fecb23f3057732b639f3034b587496f09'
$Arch = 'x64'

$Package = 'microsoft.windows.console.conpty'
$Url = "https://api.nuget.org/v3-flatcontainer/$Package/$Version/$Package.$Version.nupkg"
$Target = Join-Path $PSScriptRoot '..\src-tauri\windows\conpty'
$Files = @{
    "runtimes/win-$Arch/native/conpty.dll"        = 'conpty.dll'
    "build/native/runtimes/$Arch/OpenConsole.exe" = 'OpenConsole.exe'
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
$Download = Join-Path ([System.IO.Path]::GetTempPath()) "$Package.$Version.nupkg"

Write-Host "Downloading ConPTY $Version ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $Url -OutFile $Download -UseBasicParsing

$Actual = (Get-FileHash -Algorithm SHA256 -Path $Download).Hash.ToLowerInvariant()
if ($Actual -ne $Sha256) {
    Remove-Item $Download -Force
    throw "SHA256 mismatch for $Package $Version`n  expected $Sha256`n  got      $Actual"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [System.IO.Compression.ZipFile]::OpenRead($Download)
try {
    foreach ($Entry in $Files.Keys) {
        $Found = $Zip.Entries | Where-Object { $_.FullName -eq $Entry }
        if (-not $Found) { throw "$Entry is missing in the package" }
        $Destination = Join-Path $Target $Files[$Entry]
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Found, $Destination, $true)
        Write-Host "  $($Files[$Entry])"
    }
}
finally {
    $Zip.Dispose()
    Remove-Item $Download -Force
}
Write-Host "ConPTY ready in $((Resolve-Path $Target).Path)"
