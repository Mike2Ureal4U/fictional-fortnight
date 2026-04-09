param(
    [string]$ApiKey = $env:ALPHAVANTAGE_API_KEY,
    [string]$OutputPath = "..\data\etf_prices.csv",
    [int]$PauseSeconds = 15,
    [switch]$Full
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw "Provide -ApiKey or set the ALPHAVANTAGE_API_KEY environment variable."
}

function Get-JsonValue {
    param(
        $Object,
        [string]$Key
    )

    if ($null -eq $Object) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Key)) {
            return $Object[$Key]
        }
        return $null
    }

    $property = $Object.PSObject.Properties[$Key]
    if ($property) {
        return $property.Value
    }

    return $null
}

$etfs = @(
    @{ ticker = "XLI"; name = "Industrials"; basket = "cyclical" },
    @{ ticker = "XLB"; name = "Materials"; basket = "cyclical" },
    @{ ticker = "XLY"; name = "Consumer Discretionary"; basket = "cyclical" },
    @{ ticker = "XLE"; name = "Energy"; basket = "cyclical" },
    @{ ticker = "XLF"; name = "Financials"; basket = "cyclical" },
    @{ ticker = "XLP"; name = "Consumer Staples"; basket = "defensive" },
    @{ ticker = "XLV"; name = "Healthcare"; basket = "defensive" },
    @{ ticker = "XLU"; name = "Utilities"; basket = "defensive" },
    @{ ticker = "GLD"; name = "Gold"; basket = "defensive" }
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolvedOutputPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDir $OutputPath))
$outputDir = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$outputSize = if ($Full) { "full" } else { "compact" }
$generatedAtUtc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
$rows = New-Object System.Collections.Generic.List[object]

for ($index = 0; $index -lt $etfs.Count; $index += 1) {
    $etf = $etfs[$index]
    $url = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=$($etf.ticker)&outputsize=$outputSize&apikey=$ApiKey"

    Write-Host "Fetching $($etf.ticker) ($($index + 1)/$($etfs.Count))"
    $rawResponse = Invoke-WebRequest -Uri $url -Method Get -UseBasicParsing
    $response = $rawResponse.Content | ConvertFrom-Json

    $errorMessage = Get-JsonValue -Object $response -Key "Error Message"
    if ($errorMessage) {
        throw "$($etf.ticker): $errorMessage"
    }

    $information = Get-JsonValue -Object $response -Key "Information"
    if ($information) {
        throw "$($etf.ticker): $information"
    }

    $note = Get-JsonValue -Object $response -Key "Note"
    if ($note) {
        throw "$($etf.ticker): $note"
    }

    $series = Get-JsonValue -Object $response -Key "Time Series (Daily)"
    if (-not $series) {
        $availableKeys = @()
        if ($response -is [System.Collections.IDictionary]) {
            $availableKeys = $response.Keys
        } else {
            $availableKeys = $response.PSObject.Properties.Name
        }
        throw "$($etf.ticker): response did not include 'Time Series (Daily)'. Keys returned: $($availableKeys -join ', ')"
    }

    if ($series -is [System.Collections.IDictionary]) {
        $days = $series.Keys | Sort-Object
    } else {
        $days = $series.PSObject.Properties.Name | Sort-Object
    }

    foreach ($day in $days) {
        $entry = Get-JsonValue -Object $series -Key $day
        $closeValue = Get-JsonValue -Object $entry -Key '5. adjusted close'
        if (-not $closeValue) {
            $closeValue = Get-JsonValue -Object $entry -Key '4. close'
        }

        if (-not $closeValue) {
            continue
        }

        $rows.Add([PSCustomObject]@{
            ticker = $etf.ticker
            name = $etf.name
            basket = $etf.basket
            date = $day
            close = [decimal]$closeValue
            generated_at_utc = $generatedAtUtc
        })
    }

    if ($index -lt ($etfs.Count - 1) -and $PauseSeconds -gt 0) {
        Start-Sleep -Seconds $PauseSeconds
    }
}

$rows |
    Sort-Object ticker, date |
    Export-Csv -Path $resolvedOutputPath -NoTypeInformation -Encoding UTF8

Write-Host "Wrote $($rows.Count) rows to $resolvedOutputPath"
