export async function fetchText(url: string): Promise<string> {
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
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T = any>(url: string, body?: any): Promise<T> {
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
    // resp.json() is `unknown` at runtime — the JSON shape cannot be verified
    // statically, so assert the caller's generic type directly (no `any`).
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchStream(
  url: string,
  body?: any
): Promise<ReadableStream> {
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
    const responseBody = resp.body;
    if (responseBody === null) {
      throw new Error(`HTTP ${resp.status}: response body stream is null`);
    }
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}