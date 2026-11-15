# KRT Terminal

Multi-timeframe chart analysis terminal for Indian F&O: NSE/BSE indices, F&O stocks and MCX commodities.
Everything is in one static `index.html` file. No build step or server is needed.

> ⚠️ **Demo feed only.** Prices come from a built-in simulator. Stock seed prices are from 13-Nov-2026, and index/commodity levels are placeholders (use ✎ on the chart to set the real LTP and lot size). This is not live market data and not investment advice. Paper-trade results on simulated prices say nothing about real performance.

## GitHub Pages-la host panna (5 steps)

1. GitHub-la puthu repository create pannunga (e.g. `krt-terminal`). Make it **Public** (free Pages-ku public repo venum).
2. **Add file → Upload files** → indha zip-la irukura ella files-um (`index.html`, `README.md`, `.nojekyll`) drag & drop panni **Commit** pannunga.
3. Repo **Settings → Pages** open pannunga.
4. **Source: Deploy from a branch** → Branch: `main`, folder: `/ (root)` → **Save**.
5. 1–2 minute wait pannunga. Site URL: `https://<your-username>.github.io/krt-terminal/`

Phone-la open panni, browser menu-la **Add to Home screen** panna app maadhiri use pannalaam.

## Local-aa run panna

Double-click `index.html`. Illa:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Features

- Top ticker: NIFTY, SENSEX, BANKNIFTY, FINNIFTY, GIFT NIFTY, GOLD, SILVER, CRUDE, NAT GAS
- Charts: 3m · 5m · 15m · 1h · 1D · 1M, with EMA 20/50, VWAP, S/R, FVG, swings, ORB and volume profile
- Per-timeframe trend, structure, RSI, breakout/breakdown, candle patterns (completed candles only)
- Option chain with OI, OI change, PCR, walls and IV. Tap any premium to open that option's chart and analysis
- Strike suggestion with entry (ask), estimated premium SL, emergency stop, T1/T2, lots, and ₹ risk including costs
- Top 3 CE / Top 3 PE confluence candidates, refreshed every closed minute
- Five strategies with ✓/✗ checklists: ICT Silver Bullet, Gamma Unwind (Classic/LITE), Index OI, MCX Order Flow + Profile, Five-Minute ORB
- Common controls: ₹2,500 risk cap, capital-% limit, daily loss limit, correlated exposure limit, duplicate prevention, stale-data blocking
- Paper journal: stats per strategy version (expectancy, PF, max DD, losing streak, rejected count, top-3 winner share) plus an audit log you can export as JSON
- CSV import (Settings) to run the analysis on your own real candles: `date[,time],open,high,low,close[,volume]`, IST times

## Limitations

- **AI analysis button** works only when the page is opened inside Claude (claude.ai artifact). On GitHub Pages it shows "unavailable"; everything else works.
- Lot sizes, strike steps and expiry dates are approximations. Check them with your broker.
- Settings, journal and calibrations are saved in your browser (`localStorage`), per device.

## LIVE data — Angel One SmartAPI

Repo structure:
```
index.html        ← terminal (Render Static Site, already deployed)
backend/          ← live data server (Render Web Service)
  server.js  package.json  .env.example
```

### 1. Angel SmartAPI keys
1. Open https://smartapi.angelbroking.com → sign up/login with your Angel client ID → **Create an App** (Trading APIs). Redirect URL can be `https://localhost`. Copy the **API Key**.
2. Enable TOTP: https://smartapi.angelbroking.com/enable-totp → login → copy the **secret text** shown under the QR code (also scan the QR in Google Authenticator).
3. Keep your 4-digit **MPIN** ready.

### 2. Backend on Render (Web Service)
Render → **New → Web Service** → this repo →
- **Language:** Node · **Root Directory:** `backend` · **Build Command:** `npm install` · **Start Command:** `node server.js`
- **Instance:** Free works (it sleeps after 15 min idle and wakes in ~1 min when you open the terminal). Starter $7 keeps it always on and keeps OI snapshots continuous.
- **Environment Variables:**

| Key | Value |
|---|---|
| `ANGEL_API_KEY` | SmartAPI app key |
| `ANGEL_CLIENT_ID` | your Angel client ID |
| `ANGEL_PIN` | your MPIN |
| `ANGEL_TOTP_SECRET` | TOTP secret text |
| `ACCESS_KEY` | any long password you make up (protects your backend) |
| `ALLOW_ORIGIN` | `https://kkrt-chart-analyise.onrender.com` |
| `ALL_FNO` (optional) | `true` = load every F&O stock (heavier) |

Deploy. Open `https://<backend>.onrender.com/health` → should show `"loggedIn":true`.

### 3. Connect the terminal
Terminal → **Settings → Live feed** → paste backend URL + ACCESS_KEY → **Connect live**. Header shows **LIVE · ANGEL**.

Notes
- The backend uses **market-data APIs only** (login, quote, candles). It never places orders.
- Keys live only in Render environment variables — never put them in the Static Site.
- OI change = change since the backend's first snapshot of the day (Angel quotes don't include previous OI). OI-based strategies need ~15–30 min of snapshots after the backend starts.
- Index candles from Angel have no volume, so index VWAP / volume filters aren't meaningful.
- MCX mini contracts without options fall back to the full contract's options (lot sizes differ — check them).
- Weekends/holidays: last session's data is shown and paper entries are blocked.
