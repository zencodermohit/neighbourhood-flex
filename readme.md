# Neighbourhood Flex

**Live demo:** https://13-200-101-229.sslip.io (open, no login. Press **Run** or **Step 15 min**, then double-click the 3D transformer.)

Neighbourhood Flex is a predictive, transformer-level flexibility coordination platform. It watches one distribution transformer and the 20 houses behind it, forecasts the next hour of demand, detects when the transformer or one of its phases will exceed its safe limit, and coordinates network-level actions before the overload happens: load time-shifting and phase rebalancing. It then verifies what actually happened.

> "We turn fragmented neighbourhood-level flexibility and electrical visibility into one measurable, forecastable and dispatchable transformer-level resource."

This repository started as VoltNet, a peer-to-peer energy trading demo for Algofest Hackathon 2026, and has been pivoted to Neighbourhood Flex. The P2P market, wallets and PocketBase are no longer used.

## Decision Flow

Every simulated 15-minute interval runs the full loop:

```text
SENSE      20 smart meters + transformer meter (L1/L2/L3)
VALIDATE   edge gateway repairs missing readings, rejects spikes, flags stuck registers
MEASURE    transformer reading compared with the sum of meters (losses, street lighting)
FORECAST   demand per phase 15/30/45/60 min ahead + solar from the weather forecast
DETECT     forecast net load vs the transformer limit (40 kW) and per-phase limit (16 kW)
PLAN       time-shift eligible load; recommend phase rebalancing
DISPATCH   household requests (auto under policy, or after approval); phase changes need utility approval
VERIFY     planned vs committed vs delivered vs measured; escalate residual risk to the DISCOM
```

## How Each Part Is Implemented

| Solution zone | Implementation | File |
|---|---|---|
| Smart meters, 20 houses | Load split by protection class (critical, essential, flexible, highly deferrable), driven by occupancy, temperature and appliance events | `backend/core/households.py` |
| Transformer meter | Phase net load + copper and no-load losses + street lighting + meter error; voltage, current, power factor | `backend/core/transformer.py` |
| Weather and history | One synthetic year of Pune-like weather and neighbourhood history, with weather-forecast error | `backend/core/weather.py`, `backend/core/world.py` |
| Edge gateway | Fault injection, validation, imputation, phase aggregation, issue log | `backend/core/gateway.py` |
| Forecasting | Ridge regression per phase and horizon on recent demand, same time yesterday and last week, forecast temperature and calendar; scored on a 30-day holdout | `backend/core/forecasting.py` |
| Net demand and gap | Demand − solar + losses, minus flexibility already dispatched, compared with total and per-phase limits | `backend/core/flexibility.py` |
| Load time-shifting | Requests to enrolled households to move flexible or deferrable appliances to a slot with headroom, before their deadline | `backend/core/flexibility.py` |
| Phase rebalancing | Greedy reassignment of single-phase connections from the heaviest phase, based on last week's evening peak | `backend/core/flexibility.py` |
| Protection logic | Critical and essential load is never shifted; medical households are never moved or asked | `backend/core/flexibility.py` |
| Dispatch, verification, escalation | The closed loop, action queue, M&V and DISCOM escalations | `backend/core/engine.py` |
| Dashboard | Operator console streaming over WebSocket | `frontend/components/flex/` |

## Design Decisions

- **Time-shifting works through household requests, not appliance control.** Each enrolled household has an acceptance rate. The planner asks for 20% more than the gap because some households decline, and verification reports what was actually delivered.
- **Phase rebalancing is a planning action.** In practice a field crew moves the service connection during a short planned interruption, so an approved recommendation executes two simulated hours later and is verified over the following evening peaks. It cannot fix the next 60 minutes; time-shifting does that.
- **Total and per-phase limits are separate constraints.** Phase rebalancing fixes a phase overload when other phases have room; it cannot reduce total load. Time-shifting reduces both.
- **The forecaster sees baseline demand.** Load that was shifted is added back before forecasting, and planned shifts are applied once on top. Otherwise shifts would be counted twice and the forecast would react late.
- **Residual risk is reported, not hidden.** When local flexibility cannot close the gap, an escalation goes to the DISCOM for authorized network options.
- **All data is synthetic.** Meters, weather and a year of history are generated deterministically. Forecast accuracy shown on the dashboard is measured on that synthetic data, not on a real feeder.

## The Simulated Neighbourhood

- 50 kVA transformer, safe limit 40 kW, per-phase limit 16 kW.
- 20 houses: 7 on L1, 7 on L2, 6 on L3. L1 carries three EVs and two large homes, so it is the heaviest phase.
- 5 EV chargers, water pumps, washing machines and geysers as flexible load; 5 houses with rooftop solar.
- One household with an oxygen concentrator (protected, never asked or moved) and two other households not enrolled in the programme.
- The simulation starts on Thursday 14 May 2026 at 15:00, a hot pre-monsoon day, so the first evening peak arrives quickly.

## How To Run

Prerequisites: Python 3.11+ and Node.js 20+.

### 1. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Startup takes a few seconds: it generates a year of history and trains the forecasting models. Do not use `--reload` on Windows; the reloader can hang while the simulation loop is running.

### 2. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` and press **Run**. Useful controls:

- **Step 15 min** to walk through the evening peak one interval at a time.
- **Heatwave +2/+4/+6°C** to stress the transformer.
- **Set limit** to tighten the safe operating limit.
- Untick **Auto-send household time-shift requests** to approve every request yourself.
- **Approve, schedule crew** on a phase recommendation, then watch it execute and get verified.

### Deploying to AWS

The app runs on one EC2 instance with Docker Compose and Caddy (HTTPS, public, no login). See [deploy/README.md](deploy/README.md) for the setup, how to redeploy with `bash deploy/release.sh`, logs and teardown.

## 3D Digital Twin

The top of the dashboard is a three.js digital twin of transformer DT-07 and its 20 houses:

- Three phase feeders run to labelled poles, with particles whose speed follows phase loading and whose colour follows phase status.
- Each house shows a live load bar (blue import, green solar export), a green ring when its load has been shifted, and an amber ring when its meter reading was repaired.
- The ground halo pulses green, amber or red with transformer status, and the tank takes on a heat tint above 85% of the limit.
- Houses move to their new phase cluster when a phase reassignment is executed.

Interactions:

- **Double-click the transformer** (or press **Inspect transformer**): the camera flies in and an inspection panel opens with load, apparent power, per-phase current and voltage, the next-hour forecast and gap, and a link to pending actions. It also shows an estimated winding hot-spot temperature and insulation ageing rate after IEEE C57.91 (ONAN, 65 °C rise). These are steady-state estimates from present load and ambient temperature, not measurements.
- **Double-click a house**: its smart-meter card (import, solar, net, reading quality, enrolment, running appliances).
- **Double-click empty space** or press **Esc**: back to the overview. Drag to orbit, scroll to zoom.

### Using the Sketchfab transformer model

The view uses a built-in transformer model until you add ["High voltage power transformer" by Showdoze](https://sketchfab.com/3d-models/high-voltage-power-transformer-727bc7bb6777467dbea2ab6e0590bf4a). Sketchfab requires a logged-in account to download it:

1. Open the link, sign in, choose **Download 3D model**, and pick **glb** (or **glTF**).
2. Save it as `frontend/public/models/transformer.glb`, or unzip the glTF into `frontend/public/models/transformer/` so that `scene.gltf` sits there.
3. Reload the dashboard. It detects the file, scales it to fit, and shows the credit in the corner.

The model is licensed **CC BY-NC 4.0**: credit the author (the dashboard does) and do not use it commercially.

## Configuration

Environment variables read by `backend/config.py`:

```text
FLEX_SAFE_LIMIT_KW=40            Transformer safe operating limit
FLEX_PHASE_LIMIT_KW=16           Per-phase limit
FLEX_TRANSFORMER_KVA=50          Transformer rating
FLEX_SECONDS_PER_INTERVAL=2      Real seconds per simulated 15 minutes
FLEX_SIM_START=2026-05-14T15:00:00
FLEX_RANDOM_SEED=7
```

Frontend overrides (`frontend/.env.local`):

```text
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
NEXT_PUBLIC_STREAM_WS_URL=ws://127.0.0.1:8000/ws/stream
```

## API

```text
GET  /api/state                              Full snapshot (same payload as the stream)
POST /api/simulation/start | pause | step | reset
POST /api/simulation/speed                   {"seconds_per_interval": 1}
POST /api/config                             {"safe_limit_kw": 38, "auto_dispatch": false, "temperature_offset_c": 4}
POST /api/actions/{id}/approve | reject
POST /api/escalations/{id}/acknowledge
WS   /ws/stream                              Snapshot after every interval and every operator action
```

## Project Structure

```text
backend/
  main.py               FastAPI app
  runtime.py            Runs the engine on a timer and broadcasts snapshots
  config.py             Limits, clock and planning parameters
  routers/api.py        REST and WebSocket endpoints
  core/
    world.py            Timeline, houses and a year of history
    households.py       House profiles, protection classes, appliance events
    weather.py          Synthetic weather and forecast error
    gateway.py          Edge gateway validation and aggregation
    transformer.py      Transformer meter and consistency check
    forecasting.py      Ridge forecasting models and holdout scoring
    flexibility.py      Gap detection, time-shift planner, phase rebalancing
    engine.py           The closed loop: dispatch, verification, escalation
frontend/
  components/flex/      Dashboard, panels and forecast chart
```

The `pocketbase/` folder and `product.md` belong to the original VoltNet project and are not used by Neighbourhood Flex.
