#!/usr/bin/env python3
"""Bounded, stdlib-only PTY driver for the native MCP TUI lifecycle test."""
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time
import fcntl

sandbox, result_path = sys.argv[1:3]
with open(os.path.join(sandbox, "lifecycle.json"), encoding="utf-8") as handle:
    actions = json.load(handle)
project = os.environ["PRG_PROJECT"]
state_dir = os.environ["PRG_FIXTURE_STATE_DIR"]
event_log = os.path.join(state_dir, "event-log.jsonl")
counter_file = os.path.join(state_dir, "counter.txt")
probe_dump = os.path.join(state_dir, "probe-dump.json")
ROWS, COLS = 40, 120
DOWN, ENTER, ESCAPE, CTRL_C = b"\x1b[B", b"\r", b"\x1b", b"\x03"
OVERALL_SECONDS = 6 * 60
started_at = time.monotonic()
overall_deadline = started_at + OVERALL_SECONDS

buffer = bytearray()
master = None
child_pid = None
alive = True
reaped = False
child_status = None
exited_normally = False
last_send_offset = 0
steps = []
counters = {}


class DriverAbort(Exception):
    pass


def terminate(_signum, _frame):
    raise DriverAbort("PTY driver received its elapsed deadline signal")


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)


def poll_child():
    global alive, reaped, child_status
    if child_pid is None or reaped:
        return
    try:
        waited, status = os.waitpid(child_pid, os.WNOHANG)
    except ChildProcessError:
        reaped, alive = True, False
        return
    if waited == child_pid:
        reaped, child_status, alive = True, status, False


def pump(seconds):
    now = time.monotonic()
    if now >= overall_deadline:
        raise DriverAbort(f"PTY lifecycle exceeded its {OVERALL_SECONDS}s overall deadline")
    deadline = min(now + seconds, overall_deadline)
    while time.monotonic() < deadline and alive:
        poll_child()
        if not alive:
            break
        try:
            ready, _, _ = select.select([master], [], [], min(0.15, deadline - time.monotonic()))
            if ready:
                data = os.read(master, 65536)
                if not data:
                    return
                buffer.extend(data)
        except OSError:
            return


def visible():
    text = bytes(buffer).decode("utf-8", "replace")
    # Preserve virtual-screen row boundaries when stripping cursor positioning,
    # so the selected arrow can be paired with exactly one SelectList item.
    text = re.sub(r"\x1b\[[0-9;?]*[Hf]", "\n", text)
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    return text.replace("\x1b>", "").replace("\x1b=", "")


def fresh():
    return visible()[last_send_offset:]


def send(keys, settle=0.3):
    global last_send_offset
    if not alive:
        raise RuntimeError("Pi exited before the next TUI input")
    last_send_offset = len(visible())
    os.write(master, keys)
    pump(settle)


def chat(text):
    send(text.encode("utf-8") + ENTER, 0.55)


def wait_fresh(marker, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and alive:
        if marker in fresh():
            return
        pump(0.2)
    raise RuntimeError(f"timed out waiting for fresh TUI output {marker!r}; latest output:\n{fresh()[-4000:]}")


def read_events():
    try:
        with open(event_log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle.read().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def event_count(name):
    return sum(1 for event in read_events() if event.get("event") == name)


def wait_count(name, count, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and alive:
        if event_count(name) >= count:
            return
        pump(0.2)
    raise RuntimeError(f"timed out waiting for server {name} count >= {count}; saw {event_count(name)}")


def read_counter():
    try:
        with open(counter_file, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return 0


def selected(target):
    return re.search(r"(?:→|›|❯|➤|>)\s*[^\r\n]*" + re.escape(target), fresh(), re.IGNORECASE) is not None


def select_item(target, max_down=24):
    for _ in range(max_down + 1):
        if selected(target):
            return fresh()[-1600:]
        send(DOWN, 0.18)
    raise RuntimeError(f"native /mcp menu never selected {target!r}; latest output:\n{fresh()[-4000:]}")


def select_action(action, timeout=10):
    deadline = time.monotonic() + timeout
    saw_action = False
    while time.monotonic() < deadline and alive:
        current = fresh()
        saw_action = saw_action or action.lower() in current.lower()
        if selected(action):
            return current[-1600:]
        if saw_action:
            send(DOWN, 0.18)
        else:
            pump(0.2)
    raise RuntimeError(f"native manager did not select {action!r}; latest output:\n{fresh()[-4000:]}")


def wait_selected(target, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and alive:
        if selected(target):
            return
        pump(0.15)
    raise RuntimeError(f"native manager did not return to the selected {target!r} server list; latest output:\n{fresh()[-3000:]}")


def close_manager(server):
    # Pi's manage() keeps the selected-server submenu nested inside the server
    # list. The first Esc returns to that selected row; the second exits the
    # manager back to the chat editor.
    send(ESCAPE, 0.35)
    wait_selected(server, 10)
    send(ESCAPE, 0.35)
    # A fresh probe write proves commands reach chat again; the unchanged
    # startup header is not guaranteed to be redrawn.
    dump_snapshot("manager-closed")


def manager_toggle(server, desired):
    before_shutdown, before_init, before_lists = event_count("shutdown"), event_count("initialize"), event_count("tools_list")
    chat("/mcp")
    wait_fresh(server, 20)
    server_selection = select_item(server)
    send(ENTER, 0.5)
    event, wanted = ("shutdown", before_shutdown + 1) if desired == "disable" else ("initialize", before_init + 1)
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline and alive and event_count(event) < wanted:
        pump(0.15)
    action_selection = None
    if event_count(event) < wanted:
        action = "Disable" if desired == "disable" else "Enable"
        action_selection = select_action(action)
        send(ENTER, 0.5)
    wait_count(event, wanted)
    if desired == "enable":
        wait_count("tools_list", before_lists + 1)
    close_manager(server)
    return {
        "serverSelection": server_selection,
        "actionSelection": action_selection,
        "desired": desired,
        "initializeCount": event_count("initialize"),
        "shutdownCount": event_count("shutdown"),
    }


def dump_snapshot(name):
    previous = os.stat(probe_dump).st_mtime_ns if os.path.exists(probe_dump) else 0
    chat("/native-mcp-probe dump")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and alive:
        try:
            info = os.stat(probe_dump)
            if info.st_mtime_ns > previous:
                with open(probe_dump, encoding="utf-8") as handle:
                    snapshot = json.load(handle)
                if snapshot.get("requested") == "dump":
                    shutil.copyfile(probe_dump, os.path.join(state_dir, f"snapshot-{name}.json"))
                    return
        except (OSError, json.JSONDecodeError):
            pass
        pump(0.15)
    raise RuntimeError(f"native probe did not write the {name!r} snapshot")


def run_turn(action):
    temporary = os.path.join(state_dir, "turn-script.json.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(action["script"], handle)
        handle.write("\n")
    os.replace(temporary, os.path.join(state_dir, "turn-script.json"))
    chat(action["message"])
    wait_fresh(action["marker"], 75)
    pump(0.6)
    counters[action["name"]] = read_counter()


def cleanup():
    global alive
    if child_pid is not None:
        try:
            os.killpg(child_pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and not reaped:
            poll_child()
            time.sleep(0.05)
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except OSError:
            pass
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and not reaped:
            poll_child()
            time.sleep(0.05)
    if master is not None:
        try:
            os.close(master)
        except OSError:
            pass
    alive = False


def main():
    global master, child_pid, alive, exited_normally
    argv = [
        os.environ.get("NODE_BIN", "node"), os.environ["PRG_PI_CLI"],
        "--no-extensions",
        # --no-extensions also disables Pi's native MCP/codemode/tool-search
        # extensions. Explicitly load those real host resources while keeping
        # all ambient/user/project extension discovery disabled.
        "--extension", "builtin:mcp",
        "--extension", "builtin:codemode",
        "--extension", "builtin:tool-search",
        "--extension", os.environ["PRG_CANDIDATE"],
        "--extension", os.environ["PRG_PROBE"],
        "--extension", os.environ["PRG_OBSERVER"],
        "--no-session", "--offline", "--no-context-files", "--no-skills",
        "--no-themes", "--no-prompt-templates", "--approve",
    ]
    child_pid, master = pty.fork()
    if child_pid == 0:
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SHELL", "LOGNAME", "USER") if key in os.environ}
        env.update({
            "HOME": os.environ["PRG_HOME"],
            "USERPROFILE": os.environ["PRG_HOME"],
            "PI_CODING_AGENT_DIR": os.environ["PRG_AGENT_DIR"],
            "TERM": "xterm-256color",
            "PI_REVIEW_GATE_CODEMODE_DEFAULT": "1",
            "PRG_FIXTURE_AGENT_DIR": os.environ["PRG_HOST_AGENT_DIR"],
            "PRG_FIXTURE_STATE_DIR": os.environ["PRG_FIXTURE_STATE_DIR"],
            "PRG_FIXTURE_TOOL_OBSERVATIONS": os.environ["PRG_FIXTURE_TOOL_OBSERVATIONS"],
        })
        os.chdir(project)
        os.environ.clear()
        os.environ.update(env)
        try:
            os.execvp(argv[0], argv)
        except Exception as error:
            os.write(2, f"cannot launch Pi TUI: {error}\n".encode("utf-8", "replace"))
            os._exit(127)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.set_blocking(master, False)
    alive = True
    wait_fresh("operating mode:", 45)
    wait_count("initialize", 1)
    wait_count("tools_list", 1)

    for index, action in enumerate(actions):
        result = {"index": index, "type": action["type"], "ok": True}
        try:
            if action["type"] == "dump":
                dump_snapshot(action["name"])
                result["detail"] = f"captured actual {action['name']} Pi tool inventory"
            elif action["type"] == "turn":
                run_turn(action)
                result["detail"] = f"settled {action['name']} scripted turn; counter={counters[action['name']]}"
            elif action["type"] == "manager_toggle":
                result["detail"] = json.dumps(manager_toggle(action["server"], action["desired"]))
            elif action["type"] == "command":
                chat(action["command"])
                wait_count("initialize", action["initializeCount"])
                wait_count("tools_list", action["toolsListCount"])
                pump(0.6)
                result["detail"] = f"same-session native reconnect observed: initialize={event_count('initialize')}"
            else:
                raise RuntimeError(f"unknown lifecycle action: {action['type']}")
            result["screen"] = fresh()[-1600:]
        except Exception as error:
            result["ok"] = False
            result["error"] = str(error)
            result["screen"] = visible()[-4000:]
            steps.append(result)
            return False
        steps.append(result)

    send(CTRL_C + CTRL_C, 0.2)
    deadline = time.monotonic() + 30
    while alive and time.monotonic() < deadline:
        pump(0.2)
    poll_child()
    if alive:
        raise RuntimeError("Pi TUI did not exit after Ctrl+C twice")
    exited_normally = True
    return True


success, failure = False, None
try:
    success = main()
except Exception as error:
    failure = str(error)
finally:
    cleanup()
    result = {
        "ok": success,
        "alive": alive,
        "exitedNormally": exited_normally,
        "pid": child_pid,
        "steps": steps,
        "counters": counters,
        "lastScreen": visible()[-4000:],
        "error": failure,
    }
    try:
        with open(result_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    except OSError:
        pass
sys.exit(0 if success else 1)
