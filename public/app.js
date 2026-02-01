const form = document.getElementById("evaluate-form");
const tickerInput = document.getElementById("ticker-input");
const evaluateBtn = document.getElementById("evaluate-btn");
const apiKeyInput = document.getElementById("api-key-input");
const saveKeyCheckbox = document.getElementById("save-key-checkbox");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const reportArea = document.getElementById("report-area");
const reportContent = document.getElementById("report-content");
const copyBtn = document.getElementById("copy-btn");

let rawMarkdown = "";

// Load saved API key
const savedKey = localStorage.getItem("stock-eval-api-key");
if (savedKey) {
  apiKeyInput.value = savedKey;
  saveKeyCheckbox.checked = true;
}

// Auto-uppercase ticker input
tickerInput.addEventListener("input", () => {
  tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z]/g, "");
});

// Save/clear API key based on checkbox
saveKeyCheckbox.addEventListener("change", () => {
  if (saveKeyCheckbox.checked && apiKeyInput.value.trim()) {
    localStorage.setItem("stock-eval-api-key", apiKeyInput.value.trim());
  } else {
    localStorage.removeItem("stock-eval-api-key");
  }
});

apiKeyInput.addEventListener("input", () => {
  if (saveKeyCheckbox.checked && apiKeyInput.value.trim()) {
    localStorage.setItem("stock-eval-api-key", apiKeyInput.value.trim());
  }
});

// Copy markdown to clipboard
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(rawMarkdown);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = original), 1500);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = rawMarkdown;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = original), 1500);
  }
});

// Form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const ticker = tickerInput.value.trim();
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    tickerInput.focus();
    return;
  }

  // Disable UI
  evaluateBtn.disabled = true;
  evaluateBtn.textContent = "Evaluating...";
  rawMarkdown = "";
  reportContent.innerHTML = "";
  copyBtn.classList.add("hidden");

  // Show status
  statusBar.classList.remove("hidden");
  statusText.textContent = `Starting evaluation of ${ticker}...`;

  // Show report area
  reportArea.classList.remove("hidden");

  const body = { ticker };
  const userKey = apiKeyInput.value.trim();
  if (userKey) body.apiKey = userKey;

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let renderPending = false;

    const renderMarkdown = () => {
      renderPending = false;
      reportContent.innerHTML = marked.parse(rawMarkdown);
    };

    const scheduleRender = () => {
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(renderMarkdown);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            handleEvent(eventType, data, scheduleRender);
          } catch {
            // ignore parse errors
          }
          eventType = null;
        }
      }
    }

    // Final render
    renderMarkdown();
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    statusBar.querySelector(".spinner").style.display = "none";
  } finally {
    evaluateBtn.disabled = false;
    evaluateBtn.textContent = "Evaluate";
  }
});

function handleEvent(type, data, scheduleRender) {
  switch (type) {
    case "status":
      statusText.textContent = data.message;
      break;

    case "text":
      rawMarkdown += data.text;
      scheduleRender();
      break;

    case "done":
      statusBar.classList.add("hidden");
      copyBtn.classList.remove("hidden");
      break;

    case "error":
      statusText.textContent = `Error: ${data.message}`;
      statusBar.querySelector(".spinner").style.display = "none";
      break;
  }
}
