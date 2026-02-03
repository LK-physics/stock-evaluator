const form = document.getElementById("evaluate-form");
const tickerInput = document.getElementById("ticker-input");
const evaluateBtn = document.getElementById("evaluate-btn");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const reportArea = document.getElementById("report-area");
const reportContent = document.getElementById("report-content");
const copyBtn = document.getElementById("copy-btn");
const errorBanner = document.getElementById("error-banner");

let rawMarkdown = "";

// Logout
document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
  errorBanner.textContent = "";
}

// Auto-uppercase ticker input
tickerInput.addEventListener("input", () => {
  tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z]/g, "");
});

// Copy markdown to clipboard
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(rawMarkdown);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = original), 1500);
  } catch {
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
  hideError();

  const ticker = tickerInput.value.trim();
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    showError("Please enter a valid ticker (1-5 letters, e.g. AAPL).");
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
  statusBar.querySelector(".spinner").style.display = "";
  statusText.textContent = `Starting evaluation of ${ticker}...`;

  // Show report area
  reportArea.classList.remove("hidden");

  const body = { ticker };

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        msg = err.error || msg;
      } catch {}
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let renderPending = false;

    const renderMarkdown = () => {
      renderPending = false;
      try {
        reportContent.innerHTML = marked.parse(rawMarkdown);
      } catch (renderErr) {
        reportContent.textContent = rawMarkdown;
        showError("Markdown rendering failed: " + renderErr.message);
      }
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

      const lines = buffer.split("\n");
      buffer = lines.pop();

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            handleEvent(eventType, data, scheduleRender);
          } catch {}
          eventType = null;
        }
      }
    }

    // Final render
    renderMarkdown();
  } catch (err) {
    showError("Error: " + err.message);
    statusText.textContent = "Evaluation failed.";
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
      showError("Error: " + data.message);
      statusBar.querySelector(".spinner").style.display = "none";
      break;
  }
}
