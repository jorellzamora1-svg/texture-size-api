import express from "express";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const _sodium = require("libsodium-wrappers");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CONFIG
// --------------------
let ROBLOX_COOKIE = process.env.ROBLOX_COOKIE;

const REPO_TOKEN        = process.env.REPO_TOKEN;
const REPO_NAME         = process.env.REPO_NAME;
const RENDER_API_KEY    = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;

const CACHE     = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const MIN_VALID_SIZE = 500;
const TIMEOUT_MS     = 8000;
const MAX_RETRIES    = 2;

// --------------------
// CACHE CLEANUP
// --------------------
setInterval(() => {
    CACHE.clear();
}, CACHE_TTL);

// --------------------
// COOKIE ROTATION
// --------------------
function extractNewCookie(res) {
    // node-fetch exposes set-cookie as a raw array
    const raw = res.headers.raw?.()?.["set-cookie"] ?? [];
    const fallback = res.headers.get("set-cookie");
    const all = raw.length ? raw : fallback ? [fallback] : [];

    for (const entry of all) {
        const match = entry.match(/\.ROBLOSECURITY=([^;]+)/);
        if (match) return match[1];
    }
    return null;
}

async function encryptSecret(publicKeyB64, secretValue) {
    await _sodium.ready;
    const sodium = _sodium;
    const keyBytes = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
    const secretBytes = sodium.from_string(secretValue);
    const encrypted = sodium.crypto_box_seal(secretBytes, keyBytes);
    return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function updateGitHubSecret(secretName, secretValue) {
    try {
        const keyRes = await fetch(
            `https://api.github.com/repos/${REPO_NAME}/actions/secrets/public-key`,
            { headers: { Authorization: `Bearer ${REPO_TOKEN}` }, timeout: 10000 }
        );
        if (!keyRes.ok) throw new Error(`Key fetch failed: ${keyRes.status}`);
        const { key, key_id } = await keyRes.json();

        const encryptedValue = await encryptSecret(key, secretValue);

        const putRes = await fetch(
            `https://api.github.com/repos/${REPO_NAME}/actions/secrets/${secretName}`,
            {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${REPO_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
                timeout: 10000
            }
        );
        if (!putRes.ok) throw new Error(`Secret update failed: ${putRes.status}`);
        console.log("GitHub Secret updated successfully.");
    } catch (e) {
        console.error("Failed to update GitHub Secret:", e.message);
    }
}

async function updateRenderEnv(key, value) {
    try {
        const res = await fetch(
            `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
            {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${RENDER_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify([{ key, value }]),
                timeout: 10000
            }
        );
        if (!res.ok) throw new Error(`Render update failed: ${res.status}`);
        console.log("Render env var updated successfully.");
    } catch (e) {
        console.error("Failed to update Render env var:", e.message);
    }
}

async function handleCookieRenewal(newCookie) {
    console.log("Cookie rotated — updating secrets.");
    ROBLOX_COOKIE = newCookie;
    await Promise.all([
        updateGitHubSecret("ROBLOX_COOKIE", newCookie),
        updateRenderEnv("ROBLOX_COOKIE", newCookie)
    ]);
}

// --------------------
// FETCH WITH TIMEOUT + COOKIE ROTATION
// --------------------
async function fetchWithAuth(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
        res = await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: "follow",
            headers: {
                ...(options.headers || {}),
                ...(ROBLOX_COOKIE
                    ? { Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}` }
                    : {})
            }
        });
    } finally {
        clearTimeout(timeout);
    }

    // Check for rotated cookie
    const newCookie = extractNewCookie(res);
    if (newCookie && newCookie !== ROBLOX_COOKIE) {
        handleCookieRenewal(newCookie); // fire-and-forget, don't block the request
    }

    return res;
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
    let res = await fetchWithAuth(url, { method: "HEAD" });

    let contentLength = res.headers.get("content-length");
    let contentType   = res.headers.get("content-type") || "";

    if (res.ok && contentLength && !isBadContentType(contentType)) {
        const size = parseInt(contentLength, 10);
        if (isValidSize(size)) return size;
    }

    res = await fetchWithAuth(url);

    contentLength = res.headers.get("content-length");
    contentType   = res.headers.get("content-type") || "";

    if (!res.ok || isBadContentType(contentType)) return null;

    if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (isValidSize(size)) return size;
    }

    const buffer = await res.arrayBuffer();
    const size   = buffer.byteLength;

    return isValidSize(size) ? size : null;
}

// --------------------
// CORE: RESOLVE VIA assetId (BYPASS)
// --------------------
async function resolveViaAssetId(id) {
    const metaRes = await fetchWithAuth(
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
        let size = await resolveViaAssetId(id);

        if (!size && ROBLOX_COOKIE) {
            size = await resolveViaAssetId(id, true);
        }

        if (isValidSize(size)) return size;

        size = await resolveViaAsset(id);

        if (isValidSize(size)) return size;

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
app.get("/", (req, res) => res.send("Texture Size API V2 Running"));
app.get("/ping", (req, res) => res.send("pong"));

app.get("/size", async (req, res) => {
    const id = req.query.id;

    if (!id) return res.status(400).json({ success: false, error: "Missing id" });

    if (CACHE.has(id)) {
        return res.json({ success: true, size: CACHE.get(id), cached: true });
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
