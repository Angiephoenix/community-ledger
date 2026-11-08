// Interactive prompts for scripts/check-access.mjs.
//
// Why not node:readline: the first version wrote the label itself and then
// asked readline (terminal mode) for a line with an empty prompt. readline
// redraws its line on start ("move to column 1, clear to end of screen"),
// which erased the label, so the user saw only a cursor. It also never settled
// when input ended (Node then exits with "unsettled top-level await") and,
// with no SIGINT listener, Ctrl-C only paused it.
//
// This reader puts the terminal in raw mode from the first prompt until
// close(), so the terminal itself never echoes anything (not even keys typed
// ahead while checks are running). It writes each label once and never moves
// the cursor, echoes typed characters for visible prompts and nothing at all
// for hidden ones, and always settles: Enter resolves; Ctrl-C, Ctrl-D on an
// empty line, or the end of input reject with PromptCancelled. Ctrl-C pressed
// between prompts calls `onInterrupt`. close() restores the terminal.

export class PromptCancelled extends Error {
  constructor(reason) {
    super(reason === 'interrupt' ? 'Cancelled (Ctrl-C).' : 'Input ended before an answer was given.');
    this.name = 'PromptCancelled';
    this.reason = reason;
  }
}

export function createPrompter({ input = process.stdin, output = process.stdout, onInterrupt = () => {} } = {}) {
  let pending = ''; // characters typed ahead of the current prompt
  let ended = false;
  let current = null; // { label, hidden, buf, resolve, reject }
  let listening = false;

  const onData = (chunk) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    pump();
  };
  const onEnd = () => {
    ended = true;
    pump();
  };

  function listen() {
    if (listening) return;
    listening = true;
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.resume();
  }
  function unlisten() {
    if (!listening) return;
    listening = false;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.pause();
  }
  function setRaw(on) {
    if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(on);
  }
  function settle(fn) {
    const c = current;
    current = null;
    output.write('\n');
    fn(c);
  }

  function pump() {
    while (current && pending.length) {
      const ch = pending[0];
      pending = pending.slice(1);
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && pending[0] === '\n') pending = pending.slice(1);
        settle((c) => c.resolve(c.buf));
        return;
      }
      if (ch === '\x03') return settle((c) => c.reject(new PromptCancelled('interrupt')));
      if (ch === '\x04') {
        if (current.buf === '') return settle((c) => c.reject(new PromptCancelled('eof')));
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (current.buf.length) {
          current.buf = current.buf.slice(0, -1);
          if (!current.hidden) output.write('\b \b');
        }
        continue;
      }
      if (ch === '\x15') {
        // Ctrl-U: clear what was typed.
        if (!current.hidden) output.write('\b \b'.repeat(current.buf.length));
        current.buf = '';
        continue;
      }
      if (ch === '\x1b') {
        // Drop an escape sequence (arrow keys and the like): ESC [ ... final byte.
        const m = /^(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/s.exec(pending);
        pending = pending.slice(m?.[0]?.length ?? 0);
        continue;
      }
      if (ch < ' ') continue; // other control characters
      current.buf += ch;
      if (!current.hidden) output.write(ch);
    }
    if (current && ended) settle((c) => c.reject(new PromptCancelled('eof')));
    // Between prompts keys are kept for the next prompt, except Ctrl-C.
    if (!current && pending.includes('\x03')) {
      pending = '';
      onInterrupt();
    }
  }

  return {
    /** Shows `label` and reads one line. With `hidden`, nothing typed is shown. */
    ask(label, { hidden = false } = {}) {
      if (current) return Promise.reject(new Error('A prompt is already open.'));
      return new Promise((resolve, reject) => {
        current = { label, hidden, buf: '', resolve, reject };
        output.write(label);
        if (ended && !pending.length) {
          settle((c) => c.reject(new PromptCancelled('eof')));
          return;
        }
        setRaw(true);
        listen();
        pump();
      });
    },
    /** Restores the terminal (safe to call more than once). */
    close() {
      if (current) settle((c) => c.reject(new PromptCancelled('interrupt')));
      setRaw(false);
      unlisten();
    },
  };
}
