# Pipol documentation

| Page | What it covers |
|------|----------------|
| [Relay server](relay.md) | What the relay does, every environment variable, how to configure it (Cloudflare, coturn, Metered/Xirsys…), how to verify and disable it, log messages and HTTP answers. |
| [Cloudflare setup](cloudflare.md) | Step by step: TURN key, analytics token, relay variables, verification, Turnstile, day-to-day operation and troubleshooting. |
| [TURN and calls](turn.md) | How the app uses STUN/TURN, who can choose what (user, workspace, app), the app build variables, credential renewal, the diagnostics overlay, privacy and the security model. |
| [Closed networks](closed-network.md) | Running everything on a private network with no calls to third parties: what to leave off, what to set, and the outgoing requests that are still built in. |
| [Running everything with Docker](docker.md) | The three images (web, relay, auth) and the commands to run them; how the web image builds the app with the relay and auth addresses you give it, what to set on a server, capacity, the stress test and its safety rules. |
| [Message authenticity](security.md) | Signatures on messages, edits, deletions and reactions: who can write or change what, and what a signature does not prove. |

Planned: this folder will be published as GitHub Pages. Write pages as plain Markdown with relative links so they work both on GitHub and on the published site.
