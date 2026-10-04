from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from response_utils import api_error, success_response
from runtime import runtime
from schemas import ConfigRequest, SpeedRequest

router = APIRouter(prefix="/api", tags=["Neighbourhood Flex"])
stream_router = APIRouter(tags=["Real-time stream"])


@router.get("/state")
async def get_state():
    return success_response("Current state.", runtime.engine.snapshot())


@router.post("/simulation/start")
async def start_simulation():
    runtime.engine.running = True
    await runtime.broadcast()
    return success_response("Simulation running.", runtime.engine.snapshot())


@router.post("/simulation/pause")
async def pause_simulation():
    runtime.engine.running = False
    await runtime.broadcast()
    return success_response("Simulation paused.", runtime.engine.snapshot())


@router.post("/simulation/step")
async def step_simulation():
    runtime.engine.tick()
    await runtime.broadcast()
    return success_response("Advanced one interval.", runtime.engine.snapshot())


@router.post("/simulation/speed")
async def set_speed(payload: SpeedRequest):
    runtime.engine.seconds_per_interval = payload.seconds_per_interval
    await runtime.broadcast()
    return success_response("Speed updated.", runtime.engine.snapshot())


@router.post("/simulation/reset")
async def reset_simulation():
    runtime.reset()
    await runtime.broadcast()
    return success_response("Simulation reset to its start.", runtime.engine.snapshot())


@router.post("/config")
async def update_config(payload: ConfigRequest):
    runtime.engine.update_config(payload.model_dump(exclude_none=True))
    await runtime.broadcast()
    return success_response("Configuration updated.", runtime.engine.snapshot())


@router.post("/actions/{action_id}/approve")
async def approve_action(action_id: str):
    if runtime.engine.approve(action_id) is None:
        raise api_error(409, f"Action {action_id} is not waiting for approval.")
    await runtime.broadcast()
    return success_response(f"Action {action_id} approved.", runtime.engine.snapshot())


@router.post("/actions/{action_id}/reject")
async def reject_action(action_id: str):
    if runtime.engine.reject(action_id) is None:
        raise api_error(409, f"Action {action_id} is not waiting for approval.")
    await runtime.broadcast()
    return success_response(f"Action {action_id} rejected.", runtime.engine.snapshot())


@router.post("/escalations/{escalation_id}/acknowledge")
async def acknowledge_escalation(escalation_id: str):
    if runtime.engine.acknowledge(escalation_id) is None:
        raise api_error(409, f"Escalation {escalation_id} is not open.")
    await runtime.broadcast()
    return success_response(f"Escalation {escalation_id} acknowledged.", runtime.engine.snapshot())


@stream_router.websocket("/ws/stream")
async def stream(websocket: WebSocket):
    await runtime.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        runtime.disconnect(websocket)
