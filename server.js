import "dotenv/config";
import express from "express";
import session from "express-session";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";

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

// Read the system prompt from SKILL.md so it stays in sync with /evaluate
function loadSystemPrompt() {
  const skillPath = join(homedir(), ".claude", "skills", "evaluate", "SKILL.md");
  try {
    let content = readFileSync(skillPath, "utf-8");
    // Strip YAML frontmatter
    content = content.replace(/^---[\s\S]*?---\s*/, "");
    // Replace $ARGUMENTS with [TICKER] for the web context
    content = content.replace(/\$ARGUMENTS/g, "[TICKER]");
    // Replace tool references with natural language
    content = content.replace(/Use `WebSearch` to find/g, "Search the web to find");
    content = content.replace(/Use `WebFetch` on/g, "Look up");
    return content.trim();
  } catch (err) {
    console.error(`Warning: Could not read SKILL.md at ${skillPath}: ${err.message}`);
    console.error("Falling back to built-in prompt.");
    return "You are a stock evaluation assistant. Given a stock ticker, search the web for top-rated analyst data and produce a structured buy/no-buy report with limit order suggestions.";
  }
}

const SYSTEM_PROMPT = loadSystemPrompt();

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
      system: SYSTEM_PROMPT,
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
