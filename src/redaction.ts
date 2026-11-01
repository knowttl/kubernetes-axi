export class Redactor {
  private readonly forms = new Set<string>();

  register(...secrets: (string | undefined)[]): void {
    for (const secret of secrets) if (secret) {
      const json = JSON.stringify(secret).slice(1, -1);
      const goJson = json.replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
      for (const form of [secret, json, goJson, encodeURIComponent(secret), formEncoded, Buffer.from(secret).toString('base64')]) {
        this.forms.add(form);
        this.forms.add(JSON.stringify(form).slice(1, -1));
      }
    }
  }

  text(value: string): string {
    for (const form of [...this.forms].sort((a, b) => b.length - a.length)) value = value.split(form).join('[REDACTED]');
    return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/("(?:token|password|clientSecret|privateKey|client-key-data|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
      .replace(/^(\s*(?:token|password|clientSecret|privateKey|client-key-data|authorization)\s*:\s*).+$/gmi, '$1[REDACTED]')
      .replace(/(?:AccountKey=|sig=)[^&\s]+/gi, '[REDACTED]');
  }

  value(data: unknown): unknown {
    if (typeof data === 'string') return this.text(data);
    if (Array.isArray(data)) return data.map(value => this.value(value));
    if (data !== null && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, value]) => [this.text(key), /^(token|password|clientSecret|privateKey|client-key-data|authorization)$/i.test(key) ? '[REDACTED]' : this.value(value)]));
    return data;
  }

  terminalStream(): { push: (bytes: Buffer) => Buffer; end: () => Buffer } {
    let pending = Buffer.alloc(0);
    const flush = (final: boolean): Buffer => {
      const patterns = [...this.forms].map(form => Buffer.from(form)).sort((a, b) => b.length - a.length);
      const output: Buffer[] = [];
      let index = 0;
      while (index < pending.length) {
        const remaining = pending.subarray(index);
        if (!final && patterns.some(pattern => remaining.length < pattern.length && pattern.subarray(0, remaining.length).equals(remaining))) break;
        const match = patterns.find(pattern => remaining.subarray(0, pattern.length).equals(pattern));
        if (match) { output.push(Buffer.from('[REDACTED]')); index += match.length; }
        else { output.push(pending.subarray(index, index + 1)); index++; }
      }
      pending = Buffer.from(pending.subarray(index));
      return Buffer.concat(output);
    };
    return { push: bytes => { pending = Buffer.concat([pending, bytes]); return flush(false); }, end: () => flush(true) };
  }

  byteStream(): { push: (bytes: Buffer) => Buffer; end: () => Buffer } {
    const patterns = [...this.forms].map(form => Buffer.from(form));
    const hold = Math.max(0, ...patterns.map(pattern => pattern.length - 1));
    let pending = Buffer.alloc(0);
    return {
      push: bytes => {
        pending = Buffer.concat([pending, bytes]);
        if (patterns.some(pattern => pending.includes(pattern))) throw new Error('protected binary output');
        const count = Math.max(0, pending.length - hold);
        const safe = Buffer.from(pending.subarray(0, count));
        pending = Buffer.from(pending.subarray(count));
        return safe;
      },
      end: () => { const safe = pending; pending = Buffer.alloc(0); return safe; },
    };
  }
}
