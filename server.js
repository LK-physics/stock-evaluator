import "dotenv/config";
import express from "express";
import session from "express-session";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// Session middleware
app.use(
  session({
    secret: process.env.SESSION_SECRET || "stock-evaluator-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      secure: "auto",
      sameSite: "lax",
    },
  })
);

// Login endpoint
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.SITE_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Incorrect password" });
});

// Logout endpoint
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Auth guard — allow login page assets through, redirect everything else
app.use((req, res, next) => {
  const publicPaths = ["/login.html", "/style.css"];
  if (req.session.authenticated || publicPaths.includes(req.path)) {
    return next();
  }
  console.log(`Auth blocked: ${req.method} ${req.path} — redirecting to login`);
  res.redirect("/login.html");
});

app.use(express.static(join(__dirname, "public")));

// System prompt — embedded from SKILL.md
function buildSystemPrompt(ticker) {
  return `# Stock Evaluation: Top-Analyst Consensus & Entry Price Calculator

Evaluate the stock ticker provided in ${ticker} using top-rated (4-5 star) analyst data, and produce a structured buy/no-buy report with limit order suggestions.

If no ticker is provided, ask the user for one before proceeding.

## Step 1: Get Current Stock Data

Search the web to find the stock's current data:
- Current / pre-market price
- 52-week high and low
- Market cap
- Sector and industry
- Next earnings date (critical for red-flag check)
- Recent significant news (last 2 weeks)

Search queries:
- \`${ticker} stock price today\`
- \`${ticker} stock 52 week high low\`
- \`${ticker} next earnings date 2026\`

## Step 2: Gather Top-Analyst Ratings

Search for 4-5 star analyst coverage from financial sources.

Search queries:
- \`${ticker} stock top analyst ratings TipRanks\`
- \`${ticker} stock analyst price target 2026\`
- \`${ticker} stock Wall Street analyst consensus\`
- \`${ticker} stock analyst upgrades downgrades\`
- \`site:tipranks.com ${ticker} stock forecast\`

Look up the most relevant TipRanks or analyst-aggregation pages to extract:
- Number of top-rated analysts covering this stock
- Each analyst's rating (Strong Buy / Buy / Hold / Sell / Strong Sell)
- Each analyst's individual price target
- Any recent rating changes (upgrades/downgrades in last 30 days)

If TipRanks is not accessible, fall back to:
- MarketBeat analyst ratings
- Nasdaq analyst research
- Yahoo Finance analyst estimates

## Step 3: Calculate Consensus Metrics

From the collected top-analyst data, compute:

1. **Buy percentage**: (# of Buy + Strong Buy) / (total top-analyst ratings) x 100
2. **Average price target**: mean of all top-analyst targets
3. **Median price target**: median of all top-analyst targets
4. **Low target**: minimum top-analyst target
5. **High target**: maximum top-analyst target
6. **Target spread**: (High - Low) / Median x 100 (as percentage)
7. **Upside to median**: (Median target - Current price) / Current price x 100

## Step 4: Estimate Volatility

Calculate annualized volatility from available data:

1. **52-week range method**: Volatility ~ (52w High - 52w Low) / ((52w High + 52w Low) / 2) / sqrt(252) x sqrt(252)
   - Simplified: Range% = (High - Low) / Midpoint
   - Annualized vol ~ Range% / (2 * sqrt(252/365)) (Parkinson-style estimate)
2. If recent daily moves are available, note them as additional data points.

From annualized volatility, derive:
- **1-day expected move** = Price x AnnualVol / sqrt(252)
- **1-week expected move** = Price x AnnualVol / sqrt(52)

## Step 5: Compute Entry Prices

Calculate suggested limit-order entry prices at different confidence levels.

For each horizon (1-day and 1-week), compute the price at which the stock would fall to with probability P, using a normal approximation:

| Confidence Level | Z-score | Meaning |
|---|---|---|
| 40% | -0.253 | Moderate dip likely to fill |
| 50% | -0.674 | Coin-flip dip |
| 60% | -1.036 | Meaningful pullback |

**Entry price formula**:
\`\`\`
Entry = CurrentPrice + Z * ExpectedMove
\`\`\`

Where Z is negative (looking for dips below current price).

Present as a table:
\`\`\`
| Horizon | Confidence | Z     | Entry Price | Discount % |
|---------|-----------|-------|-------------|------------|
| 1-day   | 40%       | -0.25 | $XX.XX      | -X.X%      |
| 1-day   | 50%       | -0.67 | $XX.XX      | -X.X%      |
| 1-day   | 60%       | -1.04 | $XX.XX      | -X.X%      |
| 1-week  | 40%       | -0.25 | $XX.XX      | -X.X%      |
| 1-week  | 50%       | -0.67 | $XX.XX      | -X.X%      |
| 1-week  | 60%       | -1.04 | $XX.XX      | -X.X%      |
\`\`\`

## Step 6: Apply Decision Framework

Evaluate the stock using this framework:

### Signal Strength
- **Strong Buy**: 70%+ of top analysts say Buy AND current price is well below median target (>15% upside)
- **Moderate Buy**: 60-70% Buy OR moderate upside (10-15%)
- **Neutral**: Mixed signals, narrow upside, or insufficient data
- **Avoid**: <50% Buy, price above median target, or multiple red flags

### Key Levels
- **Margin of Safety Entry**: At or below the lowest top-analyst price target
- **Value Entry**: 15-20% below the median top-analyst target
- **Fair Value**: Near the median top-analyst target
- **Overvalued**: Above the highest top-analyst target

### Red Flags (any of these warrants caution)
- Earnings report within 2 weeks (binary event risk)
- Recent downgrades from top analysts (last 30 days)
- Wide target spread (>50% of median) indicating high disagreement
- Fewer than 5 top-rated analysts covering the stock
- Stock trading above highest analyst target

## Step 7: Output Structured Report

Present the final report in this exact format:

\`\`\`
## Stock Evaluation: ${ticker}

**Date**: [today's date]
**Current Price**: $XX.XX (pre-market: $XX.XX if available)

---

### Analyst Consensus (Top-Rated Analysts Only)

| Metric | Value |
|--------|-------|
| Top Analysts Covering | X |
| Buy / Hold / Sell | X / X / X |
| % Buy (Strong Buy + Buy) | XX% |
| Average Price Target | $XX.XX |
| Median Price Target | $XX.XX |
| Low Target | $XX.XX |
| High Target | $XX.XX |
| Target Spread | XX% |
| Upside to Median Target | XX% |

### Recent Analyst Activity
- [List any upgrades/downgrades from last 30 days]

---

### Volatility & Expected Moves

| Metric | Value |
|--------|-------|
| 52-Week Range | $XX.XX - $XX.XX |
| Est. Annualized Volatility | XX% |
| 1-Day Expected Move | +/- $X.XX (X.X%) |
| 1-Week Expected Move | +/- $X.XX (X.X%) |

---

### Suggested Entry Prices (Limit Orders)

| Horizon | Confidence | Entry Price | Discount |
|---------|-----------|-------------|----------|
| 1-day   | 40%       | $XX.XX      | -X.X%    |
| 1-day   | 50%       | $XX.XX      | -X.X%    |
| 1-day   | 60%       | $XX.XX      | -X.X%    |
| 1-week  | 40%       | $XX.XX      | -X.X%    |
| 1-week  | 50%       | $XX.XX      | -X.X%    |
| 1-week  | 60%       | $XX.XX      | -X.X%    |

---

### Red Flag Check

- [ ] Earnings within 2 weeks: [Yes/No - date if yes]
- [ ] Recent downgrades: [Yes/No - details if yes]
- [ ] Wide target spread (>50%): [Yes/No - actual %]
- [ ] Low analyst coverage (<5): [Yes/No - count]
- [ ] Price above highest target: [Yes/No]

---

### VERDICT: [STRONG BUY / MODERATE BUY / NEUTRAL / AVOID]

**Summary**: [2-3 sentence justification referencing the data above]

**Recommended Action**:
- [Primary recommendation with specific price level]
- [Alternative entry strategy if applicable]
- [Risk note if any red flags present]
\`\`\`

## Important Notes

- All analysis is based on publicly available data and top-rated analyst opinions
- This is not financial advice; it is a structured summary of analyst consensus
- Entry price calculations assume normal distribution of returns (actual distributions have fat tails)
- Always note the earnings date as a key risk event
- If data for any section is unavailable, state that clearly rather than guessing`;
}

app.post("/api/evaluate", async (req, res) => {
  console.log(`Evaluate request: ticker=${req.body?.ticker}, hasApiKey=${!!req.body?.apiKey}, envKeySet=${!!process.env.ANTHROPIC_API_KEY}`);
  const { ticker, apiKey } = req.body;

  // Validate ticker
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker. Must be 1-5 uppercase letters." });
  }

  // Pick API key: user-provided > server .env
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(400).json({
      error: "No API key provided. Set ANTHROPIC_API_KEY in .env or enter one in the UI.",
    });
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    const client = new Anthropic({ apiKey: key });

    sendEvent("status", { message: `Researching ${ticker}...` });

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: buildSystemPrompt(ticker),
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 15,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Evaluate the stock ticker: ${ticker}`,
        },
      ],
    });

    let searchCount = 0;

    stream.on("event", (event) => {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "web_search_tool_use") {
          searchCount++;
          sendEvent("status", {
            message: `Searching the web (${searchCount})...`,
          });
        }
      }
    });

    stream.on("text", (text) => {
      sendEvent("text", { text });
    });

    stream.on("error", (error) => {
      sendEvent("error", { message: error.message || "Stream error" });
      res.end();
    });

    stream.on("end", () => {
      sendEvent("done", {});
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      stream.controller.abort();
    });
  } catch (error) {
    sendEvent("error", {
      message: error.message || "Failed to start evaluation",
    });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock Evaluator running at http://localhost:${PORT}`);
});
