import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CONFIG
// --------------------
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const MIN_VALID_SIZE = 500;
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;

// --------------------
// CACHE CLEANUP
// --------------------
setInterval(() => {
    CACHE.clear();
}, CACHE_TTL);

// --------------------
// FETCH WITH TIMEOUT
// --------------------
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: "follow"
        });
    } finally {
        clearTimeout(timeout);
    }
}

// --------------------
// VALIDATION
// --------------------
function isValidSize(size) {
    return typeof size === "number" && size > MIN_VALID_SIZE;
}

function isBadContentType(type) {
    if (!type) return false;
    return (
        type.includes("application/json") ||
        type.includes("text/html")
    );
}

// --------------------
// CORE: GET SIZE FROM CDN URL
// --------------------
async function getSizeFromUrl(url) {
    // HEAD first (fast)
    let res = await fetchWithTimeout(url, { method: "HEAD" });

    let contentLength = res.headers.get("content-length");
    let contentType = res.headers.get("content-type") || "";

    if (res.ok && contentLength && !isBadContentType(contentType)) {
        const size = parseInt(contentLength, 10);
        if (isValidSize(size)) return size;
    }

    // fallback GET
    res = await fetchWithTimeout(url);

    contentLength = res.headers.get("content-length");
    contentType = res.headers.get("content-type") || "";

    if (!res.ok || isBadContentType(contentType)) {
        return null;
    }

    if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (isValidSize(size)) return size;
    }

    const buffer = await res.arrayBuffer();
    const size = buffer.byteLength;

    return isValidSize(size) ? size : null;
}

// --------------------
// CORE: RESOLVE VIA assetId (BYPASS)
// --------------------
async function resolveViaAssetId(id) {
    const metaRes = await fetchWithTimeout(
        `https://assetdelivery.roblox.com/v1/assetId/${id}`
    );

    if (!metaRes.ok) return null;

    const meta = await metaRes.json();

    if (!meta.location) return null;

    return await getSizeFromUrl(meta.location);
}

// --------------------
// CORE: FALLBACK METHOD
// --------------------
async function resolveViaAsset(id) {
    const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
    return await getSizeFromUrl(url);
}

// --------------------
// MAIN RESOLVER
// --------------------
async function resolveSize(id, attempt = 0) {
    try {
        // 1️⃣ Try bypass method (most reliable)
        let size = await resolveViaAssetId(id);

        if (isValidSize(size)) return size;

        // 2️⃣ fallback method
        size = await resolveViaAsset(id);

        if (isValidSize(size)) return size;

        // 3️⃣ retry
        if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 250));
            return await resolveSize(id, attempt + 1);
        }

        return null;

    } catch {
        if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 250));
            return await resolveSize(id, attempt + 1);
        }
        return null;
    }
}

// --------------------
// ROUTES
// --------------------
app.get("/", (req, res) => {
    res.send("Texture Size API V2 Running");
});

app.get("/ping", (req, res) => {
    res.send("pong");
});

app.get("/size", async (req, res) => {
    const id = req.query.id;

    if (!id) {
        return res.status(400).json({ success: false, error: "Missing id" });
    }

    // Return cached VALID value
    if (CACHE.has(id)) {
        return res.json({
            success: true,
            size: CACHE.get(id),
            cached: true
        });
    }

    const size = await resolveSize(id);

    if (!isValidSize(size)) {
        return res.json({ success: false, error: "Failed to resolve size" });
    }

    CACHE.set(id, size);

    return res.json({ success: true, size });
});

// --------------------
app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
});
