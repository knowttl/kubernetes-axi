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

  byteStream(): { push: (bytes: Buffer) => Buffer; end: () => Buffer } {
    const patterns = [...this.forms].map(form => {
      const bytes = Buffer.from(form);
      const fallback = new Uint32Array(bytes.length);
      for (let index = 1, matched = 0; index < bytes.length; index++) {
        while (matched && bytes[index] !== bytes[matched]) matched = fallback[matched - 1]!;
        if (bytes[index] === bytes[matched]) matched++;
        fallback[index] = matched;
      }
      return { bytes, fallback, matched: 0 };
    });
    let pending = Buffer.alloc(0);
    return {
      push: bytes => {
        pending = Buffer.concat([pending, bytes]);
        for (const pattern of patterns) for (const byte of bytes) {
          while (pattern.matched && byte !== pattern.bytes[pattern.matched]) pattern.matched = pattern.fallback[pattern.matched - 1]!;
          if (byte === pattern.bytes[pattern.matched]) pattern.matched++;
          if (pattern.matched === pattern.bytes.length) throw new Error('protected binary output');
        }
        // Only suffixes that can still complete a protected pattern remain buffered.
        const hold = Math.max(0, ...patterns.map(pattern => pattern.matched));
        const count = pending.length - hold;
        const safe = Buffer.from(pending.subarray(0, count));
        pending = Buffer.from(pending.subarray(count));
        return safe;
      },
      end: () => { const safe = pending; pending = Buffer.alloc(0); return safe; },
    };
  }
}
