"""Private, bounded JSON-lines transport to an owned Multipass engine process."""
import json
import subprocess
import threading


class EngineClient:
    def __init__(self, executable, receive, failed, dispatch):
        self.executable = executable
        self.receive = receive
        self.failed = failed
        self.dispatch = dispatch
        self.process = None
        self.next_id = 0
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.stopping = threading.Event()
        self.faulted = threading.Event()
        self.threads = []

    def start(self):
        try:
            self.process = subprocess.Popen(
                [str(self.executable), "--stdio"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                bufsize=0,
            )
        except OSError:
            self.fatal("Cannot start the engine. Check the Multipass installation.")
            return False
        for target in (self._read_events, self._drain_errors):
            thread = threading.Thread(target=target, daemon=True)
            self.threads.append(thread)
            thread.start()
        return True

    def send(self, command, **fields):
        failure = None
        with self.lock:
            self.next_id += 1
            payload = {"id": self.next_id, "command": command, **fields}
            data = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
            if len(data) > 8192:
                failure = "The command is too large. Quit and reopen Multipass."
            elif self.faulted.is_set():
                return self.next_id
            else:
                try:
                    if self.process is None or self.process.poll() is not None:
                        raise BrokenPipeError()
                    remaining = memoryview(data)
                    while remaining:
                        written = self.process.stdin.write(remaining)
                        if not written:
                            raise BrokenPipeError()
                        remaining = remaining[written:]
                    self.process.stdin.flush()
                except (OSError, ValueError):
                    failure = "Connection to the engine was lost. Quit and reopen Multipass."
        if failure and not self.stopping.is_set():
            self.fatal(failure)
        return self.next_id

    def _deliver(self, event):
        # Test at callback execution, not enqueue time: older state events must not
        # re-enable the UI after an EOF or failure on another thread.
        if not self.faulted.is_set() and not self.stopping.is_set():
            self.receive(event)

    def fatal(self, message):
        with self.lifecycle_lock:
            if self.faulted.is_set() or self.stopping.is_set():
                return
            self.faulted.set()
        self.dispatch(self.failed, message)
        self._terminate()

    def _terminate(self):
        child = self.process
        if child is None:
            return
        try:
            child.stdin.close()
        except (OSError, ValueError):
            pass
        if child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
            except ProcessLookupError:
                pass

    def _read_events(self):
        try:
            while not self.faulted.is_set() and not self.stopping.is_set():
                line = self.process.stdout.readline(1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
                    raise ValueError("Invalid frame")
                event = json.loads(line)
                if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                    raise ValueError("Invalid event")
                self.dispatch(self._deliver, event)
            if not self.stopping.is_set():
                self.fatal("The engine stopped. Quit and reopen Multipass to reconnect.")
        except (OSError, ValueError, UnicodeError):
            if not self.stopping.is_set():
                self.fatal("Invalid engine response. Reinstall the complete Multipass package.")

    def _drain_errors(self):
        # Structured stdout supplies diagnostics; stderr is never copied to logs.
        try:
            while self.process.stderr.read(4096):
                pass
        except (OSError, ValueError):
            pass

    def close(self):
        with self.lifecycle_lock:
            if self.stopping.is_set():
                return
            self.stopping.set()
        if self.process is None:
            return
        if not self.faulted.is_set():
            self.send("shutdown")
        try:
            self.process.stdin.close()
            self.process.wait(timeout=3)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self._terminate()
        for thread in self.threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()
