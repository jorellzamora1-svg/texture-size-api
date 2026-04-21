import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();

setInterval(() => {
    cache.clear();
}, 10 * 60 * 1000);

app.get("/", (req, res) => {
    res.send("OK");
});

app.get("/size", async (req, res) => {
    const id = req.query.id;

    if (!id) {
        return res.status(400).json({ success: false });
    }

    if (cache.has(id)) {
        return res.json({ success: true, size: cache.get(id) });
    }

    try {
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;

        const response = await fetch(url, { method: "HEAD", redirect: "follow" });

        const contentLength = response.headers.get("content-length");
        const contentType = response.headers.get("content-type");

        if (!response.ok || !contentLength || contentType?.includes("application/json")) {
            return res.json({ success: false });
        }

        const size = parseInt(contentLength, 10);

        if (size < 100) {
            return res.json({ success: false });
        }

        cache.set(id, size);

        res.json({ success: true, size });

    } catch (e) {
        res.json({ success: false });
    }
});

app.get("/ping", (req, res) => {
    res.send("pong");
});

app.listen(PORT);
