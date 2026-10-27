"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchText = fetchText;
exports.fetchJson = fetchJson;
exports.fetchStream = fetchStream;
async function fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        return await resp.text();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchJson(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return await resp.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchStream(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return resp.body;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=http.js.map