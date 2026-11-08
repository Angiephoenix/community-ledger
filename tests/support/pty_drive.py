"""Drive a command in a real pseudo-terminal (tests/check-access-cli.test.ts).

Usage: python3 pty_drive.py '<json>'
  {"argv": [...], "cwd": "...", "env": {...}, "steps": [{"expect": "text", "send": "keys"}, ...],
   "timeout": seconds}

Each step waits until `expect` appears in the output read so far (after the
previous match), then writes `send` to the terminal as typed keys. After the
last step it waits for the program to exit. Prints one JSON object:
  {"output": str, "exit": int|null, "signal": int|null, "timedOut": bool,
   "failedStep": int|null, "echoRestored": bool, "canonicalRestored": bool}
echo/canonical are the terminal's line-discipline flags after the program
exited, to show that raw mode was switched off again.
"""
import json
import os
import pty
import select
import sys
import termios
import time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec.get("cwd", "."))
    env = dict(spec.get("env", {}))
    os.execvpe(spec["argv"][0], spec["argv"], env)

out = ""
pos = 0
deadline = time.time() + spec.get("timeout", 20)
failed = None
exited = None


def read_some(wait=0.1):
    global out
    r, _, _ = select.select([fd], [], [], wait)
    if not r:
        return False
    try:
        data = os.read(fd, 65536)
    except OSError:
        return None
    if not data:
        return None
    out += data.decode("utf-8", errors="replace")
    return True


for i, step in enumerate(spec.get("steps", [])):
    want = step.get("expect", "")
    while True:
        idx = out.find(want, pos)
        if idx >= 0:
            pos = idx + len(want)
            break
        if time.time() > deadline or read_some() is None:
            failed = i
            break
    if failed is not None:
        break
    time.sleep(step.get("delay", 0.05))
    os.write(fd, step.get("send", "").encode("utf-8"))

while failed is None and time.time() < deadline:
    got = read_some()
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid:
        exited = status
        while read_some(0.05):
            pass
        break
    if got is None:
        # The terminal closed (EOF/EIO) before the process was reaped: wait for its status.
        while exited is None and time.time() < deadline:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid:
                exited = status
            else:
                time.sleep(0.02)
        break

# Terminal flags as the program left them.
try:
    attrs = termios.tcgetattr(fd)
    echo = bool(attrs[3] & termios.ECHO)
    icanon = bool(attrs[3] & termios.ICANON)
except termios.error:
    echo = icanon = None

if exited is None:
    try:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid:
            exited = status
    except ChildProcessError:
        pass
timed_out = exited is None
if timed_out:
    os.kill(pid, 9)
    os.waitpid(pid, 0)

print(json.dumps({
    "output": out,
    "exit": os.WEXITSTATUS(exited) if exited is not None and os.WIFEXITED(exited) else None,
    "signal": os.WTERMSIG(exited) if exited is not None and os.WIFSIGNALED(exited) else None,
    "timedOut": timed_out,
    "failedStep": failed,
    "echoRestored": echo,
    "canonicalRestored": icanon,
}))
