#!/usr/bin/env python3
"""Wait for one exact, already-owned macOS/Linux PID to emit a kernel exit event."""

import os
import select
import sys


def watch_macos(pid: int) -> int:
    queue = select.kqueue()
    try:
        change = select.kevent(
            pid,
            filter=select.KQ_FILTER_PROC,
            flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
            fflags=select.KQ_NOTE_EXIT,
        )
        try:
            events = queue.control([change], 1, 0)
        except OSError as error:
            print(f"ERROR {error.errno or 'registration'}", flush=True)
            return 2
        print("READY", flush=True)
        if not events:
            events = queue.control(None, 1, None)
        if len(events) != 1 or not events[0].fflags & select.KQ_NOTE_EXIT:
            print("ERROR unexpected-kernel-event", flush=True)
            return 3
        print("EXIT", flush=True)
        return 0
    finally:
        queue.close()


def watch_linux(pid: int) -> int:
    pidfd_open = getattr(os, "pidfd_open", None)
    if pidfd_open is None:
        print("ERROR pidfd-unavailable", flush=True)
        return 2
    try:
        pidfd = pidfd_open(pid, 0)
    except OSError as error:
        print(f"ERROR {error.errno or 'pidfd-open'}", flush=True)
        return 2
    try:
        poller = select.poll()
        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
        print("READY", flush=True)
        events = poller.poll()
        if not events:
            print("ERROR unexpected-kernel-event", flush=True)
            return 3
        print("EXIT", flush=True)
        return 0
    finally:
        os.close(pidfd)


def main() -> int:
    if len(sys.argv) != 2:
        print("ERROR usage", flush=True)
        return 2
    try:
        pid = int(sys.argv[1], 10)
        if pid <= 0:
            raise ValueError("invalid PID")
    except ValueError:
        print("ERROR invalid-pid", flush=True)
        return 2

    try:
        if sys.platform == "darwin":
            return watch_macos(pid)
        if sys.platform.startswith("linux"):
            return watch_linux(pid)
        print("ERROR unsupported-platform", flush=True)
        return 2
    except (OSError, AttributeError):
        print("ERROR kernel-exit-watch-unavailable", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
