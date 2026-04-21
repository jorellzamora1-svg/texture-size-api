import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// Cache only VALID results
const cache = new Map();

// Clear cache every 10 minutes
setInterval(() => {
    cache.clear();
}, 10 * 60 * 1000);

// Config
const MIN_VALID_SIZE = 500; // bytes (filters garbage responses)
const TIMEOUT_MS = 8000;

// Helper: fetch with timeout
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: "follow"
        });
        return res;
    } finally {
        clearTimeout(timeout);
    }
}

// Helper: validate response
function isValidResponse(res) {
    const contentType = res.headers.get("content-type") || "";
    return (
        res.ok &&
        !contentType.includes("application/json") &&
        !contentType.includes("text/html")
    );
}

// Root
app.get("/", (req, res) => {
    res.send("OK");
});

// Ping
app.get("/ping", (req, res) => {
    res.send("pong");
});

// Main endpoint
app.get("/size", async (req, res) => {
    const id = req.query.id;

    if (!id) {
        return res.status(400).json({ success: false, error: "Missing id" });
    }

    // Return cached valid result
    if (cache.has(id)) {
        return res.json({ success: true, size: cache.get(id), cached: true });
    }

    const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;

    try {
        // ---------------------------
        // STEP 1: Try HEAD request
        // ---------------------------
        let response = await fetchWithTimeout(url, { method: "HEAD" });

        let contentLength = response.headers.get("content-length");
        let contentType = response.headers.get("content-type") || "";

        let size = null;

        if (isValidResponse(response) && contentLength) {
            size = parseInt(contentLength, 10);
        }

        // ---------------------------
        // STEP 2: Fallback to GET if needed
        // ---------------------------
        if (!size || size < MIN_VALID_SIZE) {
            response = await fetchWithTimeout(url);

            if (!isValidResponse(response)) {
                return res.json({ success: false, error: "Invalid asset response" });
            }

            // Prefer content-length again if available
            contentLength = response.headers.get("content-length");

            if (contentLength) {
                size = parseInt(contentLength, 10);
            } else {
                const buffer = await response.arrayBuffer();
                size = buffer.byteLength;
            }
        }

        // ---------------------------
        // STEP 3: Final validation
        // ---------------------------
        if (!size || size < MIN_VALID_SIZE) {
            return res.json({ success: false, error: "Unrealistic size" });
        }

        // Cache ONLY valid values
        cache.set(id, size);

        return res.json({ success: true, size });

    } catch (err) {
        return res.json({ success: false, error: "Request failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
