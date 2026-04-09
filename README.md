# Cyclical Defensive Dashboard

This dashboard compares a basket of cyclical ETFs against a basket of defensive ETFs.

The page does not call Alpha Vantage directly. Instead, a PowerShell script downloads ETF data once per run, writes it to a CSV file, and the dashboard reads that CSV.

## Files

- Dashboard page: `index.html`
- Dashboard logic: `app.js`
- Data updater script: `scripts/update-etf-data.ps1`
- Output CSV: `data/etf_prices.csv`

## ETF baskets

Cyclical:

- `XLI`
- `XLB`
- `XLY`
- `XLE`
- `XLF`

Defensive:

- `XLP`
- `XLV`
- `XLU`
- `GLD`

## How to refresh the data

Open PowerShell and run:

```powershell
cd C:\Users\micha\Documents\DEV\RunningMan\cyclical_defensive_dashboard\scripts
.\update-etf-data.ps1 -ApiKey "YOUR_ALPHA_VANTAGE_KEY"
```

If the script succeeds, you should see output like:

```text
Fetching XLI (1/9)
...
Fetching GLD (9/9)
Wrote 900 rows to C:\Users\micha\Documents\DEV\RunningMan\cyclical_defensive_dashboard\data\etf_prices.csv
```

## How to use the dashboard

1. Run the PowerShell updater script.
2. Open `index.html` through your normal local server or hosted site.
3. Click `Load CSV Data`.

If the CSV is missing, the dashboard falls back to demo data.

## Alpha Vantage notes

- The script now uses the free-tier `TIME_SERIES_DAILY` endpoint.
- The script defaults to `compact` history, not `full`.
- `compact` returns about 100 trading days, which is enough for the current dashboard calculations.
- `full` is only for premium Alpha Vantage plans.

## Current workflow

- Run the updater once per day.
- Let it finish all 9 ETF fetches.
- Reload the dashboard and click `Load CSV Data`.

## Troubleshooting

If PowerShell says the API returned an `Information` or `Note` message:

- Check whether Alpha Vantage is rate-limiting the request.
- Make sure you are not trying to use premium-only parameters.
- Confirm the API key is correct.

If the dashboard does not show real data:

- Confirm [etf_prices.csv](C:\Users\micha\Documents\DEV\RunningMan\cyclical_defensive_dashboard\data\etf_prices.csv) exists.
- Confirm the CSV has rows beyond the header.
- Reload the page and click `Load CSV Data` again.
