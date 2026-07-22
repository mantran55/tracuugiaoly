let tokenCache;

const base64url = value => btoa(String.fromCharCode(...new Uint8Array(value)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(credentials) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = base64url(new TextEncoder().encode(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const pem = credentials.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), char => char.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${signature}` })
  });
  if (!response.ok) throw new Error(`Google authentication failed: ${await response.text()}`);
  const result = await response.json();
  tokenCache = { token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return tokenCache.token;
}

async function request(credentials, spreadsheetId, path, options = {}) {
  const token = await accessToken(credentials);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/${path}`, {
    ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Google Sheets error: ${await response.text()}`);
  return response.status === 204 ? {} : response.json();
}

function createSheetsClient(credentials) {
  return { spreadsheets: { values: {
    get: ({ spreadsheetId, range, valueRenderOption }) => request(credentials, spreadsheetId, `values/${encodeURIComponent(range)}${valueRenderOption ? `?valueRenderOption=${valueRenderOption}` : ""}`).then(data => ({ data })),
    update: ({ spreadsheetId, range, valueInputOption = "RAW", requestBody }) => request(credentials, spreadsheetId, `values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`, { method: "PUT", body: JSON.stringify(requestBody) }),
    append: ({ spreadsheetId, range, valueInputOption = "RAW", requestBody }) => request(credentials, spreadsheetId, `values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption}`, { method: "POST", body: JSON.stringify(requestBody) }),
    batchUpdate: ({ spreadsheetId, requestBody }) => request(credentials, spreadsheetId, "values:batchUpdate", { method: "POST", body: JSON.stringify(requestBody) })
  } } };
}

module.exports = { createSheetsClient };
