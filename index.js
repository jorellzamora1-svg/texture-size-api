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
        const response = await fetch(
            `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
            { redirect: "follow" }
        );

        let size = response.headers.get("content-length");

        if (size) {
            size = Number(size);
        } else {
            const buffer = await response.arrayBuffer();
            size = buffer.byteLength;
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
