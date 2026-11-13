# GovFlow

Centralized HQ demo for multi-branch government visitor and queue operations.

## Run locally

Requirements: Node.js 18+ and npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`). The API runs on `http://127.0.0.1:4000`. On first start, it seeds synthetic branch and ticket data and persists changes in `.data/state.json`.

Other commands:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd start
```

`npm start` starts only the API. Build the web client with `npm run build`; serve the generated `dist/` directory with a static web server configured to proxy `/api` to the API.

## Included in this MVP

- HQ overview with branch filtering, queue metrics, branch performance, and explicitly illustrative hourly/heatmap demo charts.
- Live queue workflow: issue a ticket, call a waiting ticket, complete service, or mark a walk-away.
- Branch directory with add-branch, staff-count, and wait-target controls.
- Ticket-only visitor log and CSV export.
- Local API persistence, request validation, synthetic seed data, and periodic dashboard refresh.

Visitor tickets are intentionally pseudonymous: the demo stores ticket ID, branch, service category, timestamps, and queue status—not visitor names, identity documents, or face data.

## Important limitations

This is a local MVP/demo, **not ready for government production or real citizen data**. The API has no authentication, authorization, HTTPS, database migrations, audit log, or production-grade retention controls. Its JSON file store is intended for single-process local demonstration only. Do not expose it to a network or enter personal or sensitive information. The charts and staffing insights marked illustrative use synthetic values; they are not derived from camera data.

Before deployment, replace the local JSON store with an appropriately secured database, add HQ and branch role-based access, transport security, audit and retention policies, backups, operational monitoring, and independent security/privacy review. Camera, identity, and biometric integrations are not implemented.

## Authorized Hikvision RTSP viewer

The separate [`hik_stream.py`](./hikvsion/hik_stream.py) utility discovers channels on one configured camera/NVR through ISAPI and displays an RTSP feed. Use it only with a device and account you are authorized to administer. It does not scan networks or guess credentials. RTSP video is not encrypted by this client; use a trusted isolated network or VPN, and do not expose the camera to the public internet.

Install the Python dependencies and run the unit tests:

```powershell
py -m pip install -r requirements.txt
py -m unittest discover -s hikvsion -p "test_*.py"
```

Set the password through the environment rather than a command-line argument. On PowerShell, this prompts without storing the password in shell command history:

```powershell
$env:HIKVISION_IP = "192.168.1.64"
$env:HIKVISION_USER = "viewer"
$env:HIKVISION_PASS = Read-Host "Camera password"
py .\hikvsion\hik_stream.py --stream sub
```

Bash:

```bash
read -s -p "Camera password: " HIKVISION_PASS; export HIKVISION_PASS; echo
export HIKVISION_IP=192.168.1.64 HIKVISION_USER=viewer
python hikvsion/hik_stream.py --stream sub
unset HIKVISION_PASS
```

Examples:

```bash
# Basic use
python hikvsion/hik_stream.py --ip 192.168.1.64 --user viewer

# HTTPS with a self-signed certificate (trusted network only)
python hikvsion/hik_stream.py --ip 192.168.1.64 --user viewer --https --insecure

# List device details, discovered channels, and masked URL candidates
python hikvsion/hik_stream.py --ip 192.168.1.64 --user viewer --list

# Logical channel 2 over UDP
python hikvsion/hik_stream.py --ip 192.168.1.64 --user viewer --channel 2 --no-tcp
```

PowerShell equivalents, after setting `HIKVISION_PASS` as shown above:

```powershell
py .\hikvsion\hik_stream.py --ip 192.168.1.64 --user viewer
py .\hikvsion\hik_stream.py --ip 192.168.1.64 --user viewer --https --insecure
py .\hikvsion\hik_stream.py --ip 192.168.1.64 --user viewer --list
py .\hikvsion\hik_stream.py --ip 192.168.1.64 --user viewer --channel 2 --no-tcp
```

The stream ID convention is `channel × 100 + stream index`; discovered IDs are preferred, with synthesized IDs used only when discovery is skipped or does not include the requested stream.

| Logical channel | Main | Sub | Third, if reported by the device |
|---:|---:|---:|---:|
| 1 (standalone camera) | 101 | 102 | 103 |
| 2 (NVR channel 2) | 201 | 202 | 203 |
| 10 | 1001 | 1002 | 1003 |

The viewer tries `/Streaming/Channels/<id>`, then `/ISAPI/Streaming/channels/<id>`, then the legacy `/h264/ch<channel>/<main|sub>/av_stream` path. Press **q** or **Esc** to quit, **s** to save a snapshot, and **m** to switch between main and sub streams. It keeps logs free of URL passwords; avoid supplying `--password` because command-line arguments may be visible to other local processes.

### Camera viewer troubleshooting

- **401 Unauthorized:** Verify the password, selected authentication scheme, and that the account is not locked. The camera UI may place authentication settings under **System → Security → Authentication** (names vary by firmware). The script fails fast rather than repeatedly retrying bad credentials.
- **403 Forbidden:** Grant the dedicated viewer account remote access and live-view permission; avoid using the admin account.
- **Black/gray frames:** Try TCP with the default `--tcp` (UDP packet loss can break video), verify the stream ID with `--list`, and try `--stream sub`. A gray image may remain until the next keyframe, particularly with long I-frame intervals or H.264+/H.265+.
- **High latency:** Use the sub stream, TCP/nobuffer mode, a shorter camera I-frame interval, and keep the reader thread draining frames. Some FFmpeg backends ignore the buffer-size hint.
- **Stream not found / 404:** Discovery IDs vary by model and firmware. Check `--list`, then let the client try its alternate RTSP URL formats.
- **Enable services:** RTSP port is commonly under **Network → Basic Settings → Port**; ISAPI is commonly under **Network → Advanced Settings → Integration Protocol**. Menu names vary. Create a dedicated least-privilege account.
- **Special-character passwords:** Set `HIKVISION_PASS`; the viewer percent-encodes RTSP URL user-info and masks it in logs. Prefer the environment over `--password`.
- **Maximum connections reached:** Close stale clients or sessions and reduce concurrent viewers.

Install `opencv-python`, not `opencv-python-headless`; the headless package does not provide the GUI needed for the live window.

## API routes

- `GET /api/health` — local API health.
- `GET /api/state` — branches and ticket records for the dashboard.
- `POST /api/visitors` — issue a ticket using `branchId` and `serviceCategory`.
- `PATCH /api/visitors/:id/action` — transition a ticket with `call`, `serve`, or `walkaway`.
- `POST /api/branches` — add a branch.
- `PATCH /api/branches/:id` — update `staffCount` and/or `targetWaitMinutes`.
