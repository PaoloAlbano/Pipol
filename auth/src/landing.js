export const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pipol Auth</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 520px;
      width: 100%;
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 12px;
      padding: 2.5rem;
    }
    .badge {
      display: inline-block;
      background: #22c55e22;
      color: #22c55e;
      border: 1px solid #22c55e44;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.75rem;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; font-size: 0.95rem; margin-bottom: 2rem; line-height: 1.5; }
    h2 { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 0.75rem; }
    .endpoints { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 2rem; }
    .endpoint {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: #0f1117;
      border: 1px solid #2d3148;
      border-radius: 8px;
      padding: 0.6rem 1rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
    }
    .method {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      min-width: 42px;
      text-align: center;
    }
    .method.get  { background: #0ea5e922; color: #0ea5e9; }
    .method.post { background: #a855f722; color: #a855f7; }
    .path { color: #e2e8f0; }
    .desc { color: #64748b; font-size: 0.8rem; margin-left: auto; font-family: sans-serif; }
    .links { display: flex; gap: 1rem; }
    .links a {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.15s;
    }
    .links a:hover { color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● running</div>
    <h1>Pipol Auth</h1>
    <p class="subtitle">
      Stateless OIDC authentication backend for Pipol.<br>
      Verifies identity tokens and returns a stable secret for key derivation — no database required.
    </p>

    <h2>Endpoints</h2>
    <div class="endpoints">
      <div class="endpoint">
        <span class="method post">POST</span>
        <span class="path">/derive</span>
        <span class="desc">Verify token → serverSecret</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path"><a href="/healthcheck" style="color:inherit">/healthcheck</a></span>
        <span class="desc">Health check</span>
      </div>
    </div>

    <div class="links">
      <a href="https://github.com/PaoloAlbano/Pipol" target="_blank" rel="noopener">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        GitHub
      </a>
      <a href="/healthcheck">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Healthcheck
      </a>
    </div>
  </div>
</body>
</html>`
