// Observe client WebSocket messages without changing the proxied bytes. Never
// retain more than a small heartbeat discriminator, log content, or observe
// server pushes as participant activity. Control frames and Vite HMR are passive.
export function previewActivity(protocol: string | undefined, used: () => void) {
  if (protocol?.split(",").some((value) => value.trim() === "vite-hmr"))
    return (_chunk: Buffer) => {};
  let header = Buffer.alloc(0);
  let remaining = 0;
  let offset = 0;
  let mask: Buffer | null = null;
  let opcode = 0;
  let final = false;
  let message = Buffer.alloc(0);
  let large = false;
  let compressed = false;
  let disabled = false;
  const finish = () => {
    if (opcode > 2 || !final) return;
    if (!compressed) {
      const text = message.toString("utf8").trim();
      let heartbeat = /^(ping|pong|heartbeat)$/i.test(text);
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object" && "type" in value)
          heartbeat ||= /^(ping|pong|heartbeat)$/i.test(String(value.type));
      } catch {
        /* Application text need not be JSON. */
      }
      if (large || (message.length && !heartbeat)) used();
    }
    message = Buffer.alloc(0);
    large = false;
    compressed = false;
  };
  return (chunk: Buffer) => {
    if (disabled) return;
    let cursor = 0;
    while (cursor < chunk.length) {
      if (!remaining) {
        // Read only the frame header, so an arbitrarily large frame cannot
        // allocate an equally large activity-inspection buffer.
        header = Buffer.concat([header, chunk.subarray(cursor, ++cursor)]);
        if (header.length < 2) continue;
        const short = (header[1] as number) & 127;
        const size = short === 126 ? 2 : short === 127 ? 8 : 0;
        const masked = Boolean((header[1] as number) & 128);
        if (header.length < 2 + size + (masked ? 4 : 0)) continue;
        const length =
          size === 8
            ? header.readBigUInt64BE(2)
            : BigInt(size === 2 ? header.readUInt16BE(2) : short);
        if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
          disabled = true;
          return;
        }
        remaining = Number(length);
        opcode = (header[0] as number) & 15;
        final = Boolean((header[0] as number) & 128);
        if (opcode === 1 || opcode === 2) {
          message = Buffer.alloc(0);
          large = false;
          compressed = Boolean((header[0] as number) & 64);
        }
        mask = masked ? header.subarray(2 + size) : null;
        offset = 0;
        header = Buffer.alloc(0);
        if (!remaining) finish();
      }
      const count = Math.min(remaining, chunk.length - cursor);
      if (opcode <= 2) {
        const sample = Buffer.from(
          chunk.subarray(cursor, cursor + Math.min(count, 4096 - message.length)),
        );
        if (mask)
          for (let index = 0; index < sample.length; index++)
            sample[index] = (sample[index] as number) ^ (mask[(offset + index) % 4] as number);
        message = Buffer.concat([message, sample]);
        if (sample.length < count) large = true;
      }
      cursor += count;
      offset += count;
      remaining -= count;
      if (!remaining && count) finish();
    }
  };
}
