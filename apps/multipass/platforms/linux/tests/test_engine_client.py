import json
from pathlib import Path
import queue
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine_client import EngineClient


class EngineClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.events = queue.Queue()
        self.failures = queue.Queue()
        self.client = None

    def tearDown(self):
        if self.client:
            self.client.close()
        self.directory.cleanup()

    def start(self, body):
        script = Path(self.directory.name) / "fake-engine"
        script.write_text(f"#!{sys.executable}\n" + body)
        script.chmod(0o755)
        self.client = EngineClient(script, self.events.put, self.failures.put, lambda callback, *args: callback(*args))
        self.assertTrue(self.client.start())

    def test_roundtrip_and_owned_shutdown(self):
        self.start('''import sys, json
assert sys.argv[1:] == ["--stdio"]
for line in sys.stdin:
    command = json.loads(line)
    if command["command"] == "shutdown": break
    print(json.dumps({"type": "result", "id": command["id"], "ok": True, "message": command["command"], "slot": command.get("slot")}), flush=True)
''')
        request_id = self.client.send("set_slot", slot=2)
        event = self.events.get(timeout=3)
        self.assertEqual(event["id"], request_id)
        self.assertEqual(event["slot"], 2)
        self.assertEqual(event["message"], "set_slot")
        self.client.close()
        self.assertEqual(self.client.process.returncode, 0)
        self.assertTrue(self.failures.empty())

    def test_malformed_output_is_reported_without_echoing_output(self):
        self.start('''import time
print("sensitive unexpected text", flush=True)
time.sleep(10)
''')
        message = self.failures.get(timeout=3)
        self.assertIn("Invalid engine response", message)
        self.assertNotIn("sensitive", message)

    def test_missing_engine_is_visible(self):
        self.client = EngineClient("/nonexistent/multipass-engine", self.events.put, self.failures.put, lambda callback, *args: callback(*args))
        self.assertFalse(self.client.start())
        self.assertIn("Cannot start", self.failures.get(timeout=1))

    def test_unexpected_exit_is_reported(self):
        self.start("pass\n")
        self.assertIn("engine stopped", self.failures.get(timeout=3))

    def assert_child_stopped(self):
        self.client.process.wait(timeout=4)
        self.assertIsNotNone(self.client.process.returncode)
        self.assertTrue(self.client.process.stdin.closed)

    def test_stdout_eof_terminates_child_even_when_sigterm_ignored(self):
        self.start('''import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.close(1)
time.sleep(30)
''')
        self.assertIn("engine stopped", self.failures.get(timeout=3))
        self.assert_child_stopped()

    def test_write_failure_terminates_child(self):
        self.start('''import time
time.sleep(30)
''')
        self.client.process.stdin.close()
        self.client.send("status")
        self.assertIn("Connection", self.failures.get(timeout=3))
        self.assert_child_stopped()

    def test_schema_failure_terminates_child(self):
        self.start('''import time
print('{"type":"state","state":{}}', flush=True)
time.sleep(30)
''')
        event = self.events.get(timeout=3)
        self.assertEqual(event["state"], {})
        self.client.fatal("Incompatible state schema")
        self.assert_child_stopped()

    def test_queued_events_are_suppressed_after_failure(self):
        pending = queue.Queue()
        self.start('''import time
print('{"type":"state","state":{}}', flush=True)
time.sleep(30)
''')
        self.events.get(timeout=3)
        self.client.dispatch = lambda callback, *args: pending.put((callback, args))
        self.client.dispatch(self.client._deliver, {"type": "state"})
        self.client.fatal("Failure")
        callback, args = pending.get(timeout=3)
        callback(*args)
        self.assertTrue(self.events.empty())
        self.assert_child_stopped()

    def test_oversize_command_fails_closed(self):
        self.start("import time\ntime.sleep(30)\n")
        self.client.send("join_pairing", code="x" * 8192)
        self.assertIn("too large", self.failures.get(timeout=3))
        self.assert_child_stopped()

    def test_partial_writes_preserve_entire_frame(self):
        self.start('''import sys, json
for line in sys.stdin:
    command = json.loads(line)
    if command["command"] == "shutdown": break
    print(json.dumps({"type": "result", "message": command["command"]}), flush=True)
''')
        original = self.client.process.stdin
        class PartialWriter:
            def write(self, data): return original.write(data[:3])
            def flush(self): return original.flush()
            def close(self): return original.close()
        self.client.process.stdin = PartialWriter()
        self.client.send("set_slot", slot=3)
        self.assertEqual(self.events.get(timeout=3)["message"], "set_slot")

    def test_oversize_output_is_rejected(self):
        self.start('''import sys, time
sys.stdout.write("x" * (1024 * 1024 + 1))
sys.stdout.flush()
time.sleep(10)
''')
        self.assertIn("Invalid engine response", self.failures.get(timeout=3))


if __name__ == "__main__":
    unittest.main()
