# Local development

## Requirements

- Node.js 24 (`.nvmrc`) and npm 11.
- Nothing else: no database, Docker, or cloud account.

## Running

```text
npm install
npm run dev
```

`npm run dev` starts two processes:

| Process | Port | Command                                   | Notes                                                  |
| ------- | ---- | ----------------------------------------- | ------------------------------------------------------ |
| API     | 3001 | `tsx watch` on `services/api/src/main.ts` | Restarts on change. Binds to `127.0.0.1` only.         |
| Web     | 5173 | Vite                                      | Hot reload. Proxies `/api` to `http://127.0.0.1:3001`. |

Open http://localhost:5173 and choose a user. Both servers stop with Ctrl+C.

The workspaces import each other's TypeScript sources directly (the `source` export condition), so no build step is needed during development.

To run the production build as one process that serves both the app and the API:

```text
npm run build
npm start        # http://localhost:3001
```

### Configuration

| Variable             | Default                 | Purpose                                                  |
| -------------------- | ----------------------- | -------------------------------------------------------- |
| `PORT`               | `3001`                  | API port.                                                |
| `HOST`               | `127.0.0.1`             | API bind address.                                        |
| `CLAIMFLOW_DATA_DIR` | `<repo>/.local`         | Where data, receipts, and the session secret are stored. |
| `CLAIMFLOW_API_URL`  | `http://127.0.0.1:3001` | Where the Vite dev server proxies `/api`.                |

## Local data

Everything lives in `.local/`, which Git ignores:

```text
.local/
  claimflow.json   claims, history, categories, idempotency records
  receipts/        <receiptId>.bin and <receiptId>.json metadata
  session-secret   random key that signs session cookies
```

`claimflow.json` is created with the seed categories on first start. Writes are serialized and saved with a write-then-rename, so a crash never leaves a half-written file and a claim is always saved together with its history entry. If the file cannot be read, the API refuses to start rather than overwrite it.

Uploaded receipts that were never attached to a claim are deleted at startup once they are more than 24 hours old.

### Resetting data safely

1. Stop the app (Ctrl+C).
2. Run `npm run reset-data`.
3. Start the app again; the seed categories are recreated and there are no claims.

The reset deletes only `claimflow.json` and `receipts/`. It keeps `session-secret`, so you stay signed in. It checks `http://127.0.0.1:3001/api/v1/health` first and refuses to run while the API is up, because a running API keeps its data in memory and would write it back.

To discard everything, including the session secret, stop the app and delete the `.local/` folder.

## Development sign-in and security boundary

The local development runtime has no production authentication. The **Signed in as** menu calls `PUT /api/v1/session`, which sets an HMAC-signed `HttpOnly` cookie for the chosen sample user. The API verifies the signature and loads the user's roles and manager from the directory in `services/api/src/adapters/local/seed.ts`. To add or change sample users, edit that file and restart.

There are no passwords: anyone who can reach the app can act as any sample user. The API binds to `127.0.0.1` by default; keep it that way, and do not store real employee or financial data in this environment.

Switching users remounts every page and discards responses still in flight for the previous user.

## Logs

The API prints one JSON object per line, for example:

```json
{
  "time": "2026-10-14T10:34:19.982Z",
  "level": "info",
  "event": "http.request",
  "requestId": "bb29…",
  "correlationId": "bb29…",
  "method": "POST",
  "route": "/claims",
  "operation": "claim.create",
  "actorId": "u-aisha",
  "status": 201,
  "outcome": "ok",
  "replayed": false,
  "durationMs": 2
}
```

Request bodies, receipt contents, and cookies are never logged.

## Troubleshooting

- **Port already in use.** Another copy is still running. On Windows, find it with `Get-NetTCPConnection -LocalPort 3001` and stop that process ID, or set `PORT`.
- **"Cannot reach the ClaimFlow API"** in the browser. The API is not running or crashed at startup; check the `[api]` output. To run the two processes in separate terminals (for example, to restart only the API), use `npm run dev -w @claimflow/api` and `npm run dev -w @claimflow/web`.
- **"Cannot read local data"** at startup. `claimflow.json` is corrupt; follow the reset steps above.
