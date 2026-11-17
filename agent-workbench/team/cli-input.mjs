import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
export async function hiddenInput(prompt) {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 2048) throw Error('输入过长');
    }
    return value.replace(/\r?\n$/, '');
  }
  const output = new Writable({
    write(c, e, cb) {
      cb();
    }
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write(prompt);
    return await rl.question('');
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}
