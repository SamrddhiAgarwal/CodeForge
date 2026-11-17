# CodeForge

A collaborative coding platform with accounts, project roles, Monaco, Yjs/Socket.IO collaboration, MongoDB persistence, Docker execution through BullMQ, Redis metadata caching, and a Gemini AI assistant. CI and production deployment configuration are prepared; hosted GitHub Actions and VPS deployment still require configuration and verification.

## Local setup

Requires Node.js 24 LTS, npm, and Linux Docker with Compose and working CPU/memory/process limits. The worker uses the local Unix Docker socket at `/var/run/docker.sock`.

```bash
npm ci
```

If `.env` is absent, create it from `.env.example`; preserve any existing configuration. Set `SESSION_SECRET` to at least 32 random characters. Keep this value private. This command fills an empty value without printing it:

```bash
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const p=".env"; const s=fs.readFileSync(p,"utf8"); fs.writeFileSync(p,s.replace(/^SESSION_SECRET=$/m,"SESSION_SECRET="+crypto.randomBytes(32).toString("hex")));'
docker compose -f compose.dev.yml up -d mongo redis
npm run runners:build
npm run dev
```

In a separate terminal, start **exactly one worker**:

```bash
npm run worker
```

Open **http://localhost:5173**. Vite proxies `/api` and `/socket.io` to Express on port 3001. Use this exact origin. Compose starts MongoDB and Redis on loopback with persistent volumes; Redis uses AOF and `noeviction`. It is not a production deployment. For existing services, configure `MONGODB_URI` and `REDIS_URL` instead. The worker intentionally does not load `.env`: if changing `REDIS_URL` or `REDIS_PREFIX`, supply the same values in its process environment. Never forward API/session secrets to it.

```bash
npm run typecheck
npm run build
docker compose -f compose.dev.yml stop
```

After building, `npm run start -w apps/api` and `npm run start -w apps/worker` start the separate processes. The web build is in `apps/web/dist`. See deployment instructions below for production serving. Changing `PORT` also requires updating the Vite proxy target.

## Structure

- `apps/web/src`: React screens; `CodeWorkspace.tsx`, `FileExplorer.tsx`, `useFileTabs.ts`, `monaco.ts`, `CollaborativeEditor.tsx`, and `ProjectChat.tsx` implement the editor and live project UI.
- `apps/api/src`: Express routes, MongoDB models, sessions, validation, and permissions; `files.ts` handles file operations, `realtime.ts` handles sockets, and `documents.ts` merges/persists Yjs state.
- `apps/api/src/executions.ts`, `redis.ts`, `projectCache.ts`: authorized submission/status, queue, and metadata cache.
- `apps/worker/src`: BullMQ consumer and bounded Docker lifecycle; the API never calls Docker.
- `packages/execution/src`: shared job validation, limits, language mapping, and result types.
- `runners/{javascript,python,cpp}`: fixed images/scripts; source enters over stdin, with no host mounts.
- `apps/web/src/ExecutionPanel.tsx`: Run button, status polling, and output panel.
- `apps/api/src/assistant.ts`, `llm.ts`, and `apps/web/src/AssistantPanel.tsx`: authorized AI requests, four prompts through one provider, and the editor side panel.
- `compose.dev.yml`: local MongoDB and Redis with separate persistent volumes.
- `.env.example`: server configuration; no frontend secrets.

Passwords use Node's asynchronous scrypt with a random salt and timing-safe comparison. MongoDB stores users, projects, and sessions. Login and registration rotate the session ID. Cookies are HTTP-only, SameSite=Lax, expire after seven days, and require HTTPS in production. Mutating requests must send the configured `APP_ORIGIN` as their Origin header. Registration and login share a per-IP rate limit (20 attempts per 15 minutes) in the single API process.

## Roles and API

The creator is the project's single owner. Owners can add registered users, switch members between Editor and Viewer, and remove members. The owner cannot be demoted or removed; ownership transfer is not supported.

| Action | Owner | Editor | Viewer | Non-member |
| --- | --- | --- | --- | --- |
| List/read own or shared projects and members | Yes | Yes | Yes | No |
| Rename/delete project, add/remove members, change member roles | Yes | No | No | No |
| List/read files and folders | Yes | Yes | Yes | No |
| Create/delete files and folders, rename files, save code | Yes | Yes | No | No |
| Read live edits, share cursor, use project chat | Yes | Yes | Yes | No |
| Submit a saved file for execution | Yes | Yes | No | No |
| Request AI advice for an accessible file | Yes | Yes | Yes | No |

Any signed-in user can create a project. `requireAuth` checks the account and session; `requireProjectRole` checks current membership and allowed roles on every project/file request. File writes also check permissions atomically in MongoDB. Removed members lose access on their next request. Non-members receive 404. The dashboard returns expired sessions to sign-in; the editor retains unsaved code on session/permission failures so it can be copied before leaving.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Register with name, email, password |
| POST | `/api/auth/login` | Sign in with email, password |
| GET | `/api/auth/me` | Current session user |
| POST | `/api/auth/logout` | Destroy session |
| GET / POST | `/api/projects` | List / create projects |
| GET / PATCH / DELETE | `/api/projects/:id` | Read / rename / delete project |
| POST | `/api/projects/:id/members` | Add by email and editor/viewer role |
| PATCH | `/api/projects/:id/members/:userId` | Change member role (editor/viewer) |
| DELETE | `/api/projects/:id/members/:userId` | Remove a member |
| GET / POST | `/api/projects/:id/files` | List nodes / create file or folder |
| GET / PATCH / DELETE | `/api/projects/:id/files/:fileId` | Read file / rename file / delete node and descendants |
| PUT | `/api/projects/:id/files/:fileId/content` | Save content with its last known revision |
| POST | `/api/projects/:id/executions` | Queue a saved file snapshot; body `{ "fileId": "..." }` |
| GET | `/api/projects/:id/executions/:jobId` | Submitter-only status/result; current membership required |
| POST | `/api/projects/:id/assistant` | AI advice; body `{ "fileId": "...", "action": "review", "scope": "selection", "code": "..." }` |

## Editor

Open a project, then **Open editor**. Select a folder (or Project root) before creating files. Extensions select JavaScript, TypeScript, Python, or C++ highlighting; other files use plain text. Monaco and its worker are bundled locally and loaded on demand. The root dependency override keeps Monaco's DOMPurify dependency on a patched release.

Yjs binds directly to Monaco models. Local changes are batched for 100 ms, including inactive tabs, with one save request per file at a time. Concurrent updates merge instead of replacing each other's text. Closing tabs or leaving through Projects waits for acknowledgements; refresh warns if local updates remain unacknowledged. Wait for **All changes saved** before refreshing. Failed saves retain local code with retry/reload/discard controls. The REST content endpoint remains revision-checked and feeds the same Yjs persistence path.

Files are embedded in the project document: deletion of a folder/subtree or the entire project is atomic on standalone MongoDB. A structural revision prevents conflicting explorer changes. To stay below MongoDB's document limit, each project supports **100 total files/folders** and each file supports **64 KiB of UTF-8 content**. Names are case-sensitive and unique within a folder. No filesystem paths are used on the host.

## Real-time collaboration

One Socket.IO connection per open project uses WebSocket transport, the existing HTTP-only session cookie, and an Origin check. Connection setup, document joins/updates, cursors, and chat validate session and project membership. Recipients are revalidated before broadcasts. Role changes and member removal notify connected clients; logout disconnects the session's sockets. A 10-second sweep removes idle expired sessions. Names and cursor colors come from authenticated accounts.

The server serializes document operations per project in the single API process. It loads the saved Yjs binary state, merges the update, and atomically writes both that state and plain text into the embedded file before acknowledging/broadcasting. Existing text files initialize once on first join. No in-memory document cache, Redis adapter, or multi-server coordination is used. Full-state updates keep retry/reconnect logic simple and idempotent.

Editing pauses on disconnect. Pending edits remain in the current browser tab, then merge with the server state after reconnect. An API restart restores Yjs state from MongoDB; presence and cursors are ephemeral and rebuilt. Cursor positions use Yjs relative positions so they follow concurrent edits. Chat persists the latest 100 messages per project, accepts up to 2,000 characters, and uses message IDs to deduplicate retries. Each browser connection appears separately in presence.

Limits: 256 KiB of encoded Yjs history per file and 12 MiB of combined document state/text per project, in addition to the file limits above. There is no automatic history compaction; copy code into a new file if its history limit is reached. This implementation favors small portfolio projects over high traffic.

## Execution and caching

**Run file** flushes pending editor saves, then the API reads the saved MongoDB snapshot and enqueues its content, language, and revision. JavaScript (`.js/.mjs/.cjs`), Python (`.py`), and C++ (`.cpp/.cc/.cxx`, C++17) are supported. The selected file runs by itself: no project imports, dependency installation, or interactive stdin. TypeScript remains editable but is not executable.

The worker processes one job at a time. The panel polls authenticated status every second while queued/running and renders stdout, stderr, exit code, duration, and limit flags as plain text. Compile/runtime errors are completed executions with nonzero exit codes; Docker/worker failures are failed jobs with sanitized messages. A stopped worker leaves jobs queued. Submitted snapshots are immutable; subsequent edits or access revocation do not cancel already accepted jobs. There is no cancel/history UI or restoration of the panel after refresh.

Each container has **256 MiB memory, no swap, 1 CPU, 64 processes, and 32 KiB combined raw output**. JavaScript/Python have 5 seconds; C++ has 15 seconds including compilation. Images enforce deadlines; an external watchdog adds a 1.5-second grace period. A bounded Docker client protects against an unresponsive daemon. Temporary writable space is limited to 64 MiB for code/build files and 16 MiB for `/tmp`. Containers use UID/GID 10001, a read-only root, no network, all capabilities dropped, no-new-privileges, Docker's default seccomp profile, and disabled Docker logging. No host paths, Docker socket, application environment, credentials, or secrets enter submitted-code containers.

Cleanup runs before a result is completed, including errors/limits. Graceful worker shutdown waits for the current bounded job. Restart removes only containers with this application's runner label and Redis prefix. **Do not start a second worker with the same prefix**: startup recovery assumes the previous process has stopped. After an abrupt failure, BullMQ may retry a stalled job once; execution is not exactly-once. If Docker itself is unavailable, cleanup must wait until it recovers and the worker restarts.

Submission is limited to 10 attempts per user/minute, with a basic queue backlog check at 100. Completed and failed jobs retain up to 100 entries each, targeting one hour of retention; BullMQ age cleanup runs when later jobs finish, not on a strict TTL. Redis contains submitted code/results and must remain private. Redis data is local AOF-backed storage, not a backup guarantee.

Project-member metadata is cached for 30 seconds after a live MongoDB authorization check. Project rename/delete and membership updates invalidate it. A fingerprint also rejects stale entries after concurrent writes. Redis failure bypasses the cache; execution requests fail with 503 while ordinary project operations remain available.

**This is not a hardened multi-tenant sandbox.** Containers share the host kernel; Docker daemon access is host-root-equivalent authority. Production Compose gives only the trusted worker the Docker socket. API/web and submitted programs receive no socket or host credentials. Development commands run under your current account and do not provide that separation. Use this setup for trusted portfolio demonstrations, not a public hostile-code service.

## AI developer assistant

Set `GEMINI_API_KEY` privately in the root `.env` and restart the API. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`; use a Gemini text model available to your account that supports `generateContent`. Supply the model ID without a `models/` prefix. Keep both settings server-side, never in `VITE_*` variables. Without a key, requests show a configuration message; there are no placeholder answers. The implementation uses Node's built-in `fetch` with the [Gemini generateContent API](https://aistudio.google.com/api-reference/generate-content/generate-content), without an AI framework. The private `.env` is preserved; add the new Gemini settings there rather than copying over existing configuration.

Open a file and choose **Code review**, **Debugging suggestions**, **Unit-test generation**, or **Code explanation** in the side panel. Selected Monaco text takes precedence; clear the selection to send the entire active editor buffer, including unsaved changes. Only the filename, context scope, and that code snapshot are sent when **Ask assistant** is clicked. Responses remain in the panel as plain text; they never modify files or execute tests. All project roles may ask for advice. Membership and file access are checked before calling the provider and again before returning the response.

Requests allow 64 KiB of UTF-8 context, a 2,000-token generation limit, 30 seconds, and 10 attempts per user/minute. Depending on the model, reasoning can consume part of that token limit. Errors cover missing/rejected configuration, provider limits, blocked prompts/candidates, empty/incomplete responses, and connectivity. Only answer text is displayed; reasoning parts are excluded. Leaving the file or losing the editor connection cancels the request. There is no automatic retry, streaming, chat history, or response persistence in CodeForge. Google's data-use and retention terms apply to submitted code. Model answers can be incorrect, and generated tests are unverified until you review and run them.

To verify with a valid key, open a small function with a known bug (for example, an addition function that subtracts). Run all four actions: check that review/debug identify the issue, tests include normal and edge cases, and explanation describes the actual behavior. Select only that function and repeat; the panel should identify selected-code context. Clear the selection and verify whole-file context. Confirm the file content and saved revision do not change. Remove the key and restart the API to verify the configuration error. Never paste keys into source files, browser fields, or terminal output.

## Manual verification

The collaboration milestone passed 45 checks against real MongoDB, Socket.IO clients, and two isolated Chromium sessions. These covered concurrent edits, remote cursors, chat, unauthorized access, disconnect/reconnect merging, an actual API restart, browser refresh, role changes, logout, and existing file/tab operations. TypeScript checks and production builds pass; the dependency audit reports no vulnerabilities. Desktop/mobile screenshots were reviewed. Verification uses a disposable database; no demo accounts are seeded.

Execution verification passed 51 checks using real runner images, BullMQ/Redis, MongoDB, and Owner/Viewer Chromium sessions. It covered all three languages, compile/runtime errors, deadlines, output/memory limits, live container restrictions, cleanup, worker/API restart, permissions, cache hits/TTL/invalidation, and browser save/run/results. Failure checks covered Redis unavailability, status retry without duplicate submission, expired results, and rate limits. Temporary verification accounts, databases, and queue data were removed.

Gemini verification passed 48 API/browser checks and five additional response-parser checks using controlled provider responses injected only into temporary verification processes. These covered all four actions, selection/file context, permissions, loading, configuration/provider errors, blocked and incomplete responses, reasoning-part filtering, deadlines, inert text rendering, and unchanged files. No fixture responses or test transport are included in the application. Live Chromium verification then exercised all four actions with a synthetic function: review/debug identified its deliberate arithmetic bug, explanation described the actual behavior, and test generation produced normal/edge cases and a regression test. File content and revision stayed unchanged. Generated tests were reviewed as text, not executed; temporary verification projects and accounts were removed.

1. Register an owner; create a project, reload the page, and confirm it persists. Rename it and confirm the updated name.
2. Sign out and sign back in. Check that a wrong password fails and an existing email cannot register again (including with different casing).
3. Register editor and viewer accounts in separate browser profiles. As owner, add each by email. Change a member's role, refresh their dashboard, and confirm the new role. Remove them with confirmation; their next list/read request must exclude or deny the project. Re-add them to restore access.
4. Confirm only the owner sees management controls. Send project-update/delete and member-add/update/delete requests directly as editor/viewer: each must return 403. Include the configured Origin header and preserve your session privately when using an HTTP client. Attempts to demote or remove the owner must return 400.
5. Register a non-member: its list must exclude the project; a direct GET for its ID must return 404. Signed-out requests must return 401.
6. Try an empty project name, invalid role, unknown email, duplicate member, and adding the owner as a member. Each must return a clear error without changing data.
7. Inspect cookies in browser developer tools: the session is HTTP-only and SameSite=Lax (Secure is enabled in production HTTPS). Sign out; replaying the old session must fail. Never share cookie values.
8. As owner, delete the project using the confirmation. Refresh each member's workspace and confirm it disappears.
9. Block project requests in browser developer tools: failures should show a retry option, not an empty workspace. Restore requests and retry. Clear the session cookie, then attempt project creation: the sign-in screen should appear.

10. Open the editor as owner. Create nested folders and `.js`, `.ts`, `.py`, and `.cpp` files. Type code, wait for Saved to MongoDB, refresh the browser, reopen the project/file, and confirm the contents persist.
11. Switch between several tabs while typing; confirm each saves independently. Rename a file, close/reopen its tab, and delete a nested folder with confirmation. Its descendants should disappear too.
12. Repeat as Editor, then Viewer. Viewers can read but cannot type or see write controls. Direct create/rename/save/delete requests as Viewer must return 403. Demote an open Editor session and verify subsequent saves fail without losing its local draft.
13. In two separate browser profiles, sign in as Owner and Editor and open the same file. Type concurrently, move/select text, and send chat. Both editors should converge; presence and colored remote cursors should appear.
14. Disconnect one browser temporarily, edit in the other, and reconnect. Pending local changes should merge. Stop/restart the API after All changes saved; both sessions should reconnect with code and chat intact. Refresh one browser to verify persistence from a fresh document.
15. As Viewer, verify live read access and chat but no editing. Demote/remove an active Editor or log its account out in another tab: editing/access must be revoked. Anonymous and non-member socket connections must fail.

16. Run `console.log("hello")`, `print("hello")`, and a C++ `main` that writes to `std::cout`; confirm exit 0 and stdout. Run `raise RuntimeError("test")` and invalid C++; confirm stderr and nonzero exit codes.
17. Run `while (true) {}` in JavaScript; confirm a timeout. Run Python `while True: print("x" * 1000)`; confirm output truncation. Run `x = bytearray(1024 * 1024 * 1024)`; confirm the container memory limit. After each result, `docker ps -a --filter label=codeforge.runner=true` should show no runner containers.
18. Stop the worker, submit a file, and confirm Queued. Restart it and watch Running/Completed. As Viewer, confirm Run is disabled and direct submission returns 403. Another member must receive 404 when requesting someone else's job result. Change membership and verify cached project details cannot restore access.

Open tabs/view positions are not restored after refresh. Folders cannot be renamed or moved. Unsaved updates are held only in browser memory, so closing/reloading despite the warning can lose them. Monaco's lazy editor bundle produces a size warning during builds. There is no distributed socket scaling. Do not expose the development services publicly.

## CI and production deployment

`.github/workflows/ci.yml` runs on pushes and pull requests using Node 24: `npm ci`, `npm run typecheck`, `npm run build`, Compose validation, and shell syntax checks. Make **TypeScript and production builds** a required branch check. CI needs no application secrets. To reproduce locally, run those three npm commands and `bash -n deploy/deploy.sh deploy/ssh-deploy.sh`.

The three `apps/*/Dockerfile` files build production images. `compose.prod.yml` runs one API, one worker, MongoDB, Redis, and Caddy serving the frontend. Caddy handles HTTPS and WebSockets; only ports 80/443 are published. MongoDB/Redis use authentication and persistent volumes on an internal network. `/api/ready` checks MongoDB and Redis; Compose also checks worker/Docker health. Restart policies recover stopped processes, but Docker does not automatically restart a process solely because it becomes unhealthy.

Local verification passed dependency installation, workspace typechecks/builds, workflow linting, and all three application image builds. An isolated production stack passed 29 checks covering verified local HTTPS, secure cookies, WebSockets, all three runner languages, cleanup, and session/file persistence after container recreation. Deployment scripts passed 15 checks with mocked transports, including failed health checks, rollback, pinned SSH host verification, and preserved environment files/volumes. These do not constitute a hosted Actions run or VPS deployment.

Deployment is **manual and disabled by default**. `.github/workflows/deploy.yml` requires `main`, repository variable `DEPLOYMENT_ENABLED=true`, and the approval checkbox. It reruns CI, builds six images (three services and three runners), pushes commit-SHA tags to GHCR, then waits for the `production` environment gate before SSH. Failed CI blocks publishing/deployment. Keep deployment disabled until the VPS is configured and its owner explicitly approves deployment.

### Prepare one Ubuntu VPS

1. Use Ubuntu 24.04 on **amd64** (the image workflow targets `linux/amd64`). Install [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/ubuntu/), plus SSH, `curl`, `tar`, and `flock`. Keep one worker per Redis prefix. Allow inbound TCP 80/443 and your SSH port; never open 27017, 6379, or 3001. Docker-published ports need Docker-aware firewall rules.
2. Point a domain's DNS A record at the VPS. Add AAAA only if IPv6 works. Caddy obtains/renews certificates automatically when DNS and ports 80/443 are reachable. No additional proxy service is needed.
3. Create a dedicated deployment user with Docker access and a deployment SSH key in its `authorized_keys`. Docker access grants host-root-equivalent authority. Create `/opt/codeforge/shared` and `/opt/codeforge/releases`, owned by that user, with private permissions. Verify the SSH host key through the VPS console or another trusted channel.
4. Create `/opt/codeforge/shared/production.env` from `deploy/production.env.example` **only if absent**, and set mode `600`. Set `APP_DOMAIN` to the domain without a scheme/path. Set a random `SESSION_SECRET` of at least 32 characters and separate random hexadecimal `MONGO_ROOT_PASSWORD`, `MONGO_APP_PASSWORD`, and `REDIS_PASSWORD`. Set `DOCKER_GID` from `stat -c '%g' /var/run/docker.sock`; keep `REDIS_PREFIX` stable. Optional `GEMINI_API_KEY` and `GEMINI_MODEL` go here, never into frontend variables or workflow logs. Deployment supplies image repository/tag itself.
5. For private GHCR images, authenticate Docker **as the deployment user** with a read-only package token using `docker login ghcr.io --username YOUR_USER --password-stdin`. Supply the token privately; do not put it in a command argument or repository. That host credential is never mounted into the worker or submitted containers. Workflow publishing uses GitHub's automatic `GITHUB_TOKEN` with `packages: write`.

Create a GitHub environment named **production**, restrict it to `main`, and enable required reviewers where your repository plan supports them. Configure these environment secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VPS IPv4 address or SSH hostname |
| `DEPLOY_PORT` | SSH port, normally `22` |
| `DEPLOY_USER` | Dedicated deployment username |
| `DEPLOY_PATH` | Absolute directory, e.g. `/opt/codeforge`, without a trailing slash |
| `DEPLOY_APP_URL` | `https://codeforge.example.com`, matching `APP_DOMAIN`, without a trailing slash |
| `SSH_PRIVATE_KEY` | Deployment user's private SSH key; never share it in chat |
| `SSH_KNOWN_HOSTS` | Verified known_hosts entry for that host (`[host]:port` for a custom port) |

The path supports letters, digits, `/`, `_`, and `-`; SSH targets support hostnames/IPv4. Credentials must be noninteractive. Keep repository variable `DEPLOYMENT_ENABLED` unset/false until approval. After approval, set it to `true`, run **Deploy** from `main`, and explicitly check the approval input. The SSH script copies only runtime configuration into a SHA release directory, pulls matching images, runs Compose with `--wait`, and verifies public HTTPS readiness. It never overwrites `shared/production.env` or removes database volumes.

### Operations and rollback

Deployment uses the stable Compose project name `codeforge-prod` so volumes survive release-directory changes. `current` points to the last healthy release and `previous` to its predecessor. A failed deployment can leave updated services running; review its logs and explicitly roll back. There is no automatic rollback or zero-downtime guarantee.

On the VPS, inspect services without printing expanded environment configuration:

```bash
export IMAGE_REPOSITORY=ghcr.io/your-owner/your-repo
export IMAGE_TAG=FULL_DEPLOYED_COMMIT_SHA
docker compose -p codeforge-prod --env-file /opt/codeforge/shared/production.env -f /opt/codeforge/current/compose.prod.yml ps
```

To roll back, choose a retained, previously healthy full commit SHA and run its deployment script with the same root, repository, and URL:

```bash
bash /opt/codeforge/releases/FULL_PREVIOUS_SHA/deploy/deploy.sh /opt/codeforge FULL_PREVIOUS_SHA ghcr.io/your-owner/your-repo https://codeforge.example.com
```

Retain release images and back up MongoDB/Redis volumes before upgrades. Rollback changes application images, not database contents. Never use `down --volumes` or volume pruning on this deployment. MongoDB passwords initialize only on an empty volume: changing the environment file does not rotate existing database users; rotate credentials in MongoDB as well. Preserve Caddy volumes for certificates.

After an approved deployment, check the Actions result, Compose health, and `https://YOUR_DOMAIN/api/ready`. In two browser profiles verify registration/login, a saved file after refresh, live edits/chat, and execution in each language. Restart/recreate services without removing volumes and confirm sessions, files, and jobs persist. Hosted Actions and VPS verification remain pending until publication, credentials, and explicit deployment approval are provided.
