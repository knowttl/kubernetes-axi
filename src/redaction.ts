import { StringDecoder } from 'node:string_decoder';

const fields = 'token|password|clientSecret|privateKey|client-key-data|authorization';
const textRules: [RegExp, string][] = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [new RegExp(`("(?:${fields})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi'), '$1"[REDACTED]"'],
  [new RegExp(`^(\\s*(?:${fields})\\s*:\\s*).+$`, 'gmi'), '$1[REDACTED]'],
  [/(?:AccountKey=|sig=)[^&\s]+/gi, '[REDACTED]'],
];

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
    for (const [pattern, replacement] of textRules) value = value.replace(pattern, replacement);
    return value;
  }

  value(data: unknown): unknown {
    if (typeof data === 'string') return this.text(data);
    if (Array.isArray(data)) return data.map(value => this.value(value));
    if (data !== null && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, value]) => [this.text(key), /^(token|password|clientSecret|privateKey|client-key-data|authorization)$/i.test(key) ? '[REDACTED]' : this.value(value)]));
    return data;
  }

  terminalStream(): { push: (bytes: Buffer) => Buffer; end: () => Buffer } {
    const decoder = new StringDecoder('utf8');
    const names = fields.split('|');
    const markers = ['-----BEGIN ', 'eyJ', 'AccountKey=', 'sig=', ...names.map(name => `"${name}"`)];
    let pending = '';
    let lineStart = true;
    let shown = 0;
    const flush = (final: boolean): Buffer => {
      let count = pending.length;
      if (!final) {
        const lower = pending.toLowerCase();
        for (const marker of [...markers, ...this.forms]) {
          const insensitive = markers.includes(marker);
          for (let size = 1; size < marker.length && size <= pending.length; size++) {
            if ((insensitive ? lower : pending).endsWith((insensitive ? marker.toLowerCase() : marker).slice(0, size))) count = Math.min(count, pending.length - size);
          }
        }
        const unfinished = [
          /-----BEGIN [^-]*(?:-[^-]*){0,4}$/g,
          /-----BEGIN [^-]*PRIVATE KEY-----(?:(?!-----END [^-]*PRIVATE KEY-----)[\s\S])*$/g,
          /eyJ[A-Za-z0-9_.-]*$/g,
          /(?:AccountKey=|sig=)[^&\s]*$/gi,
          new RegExp(`"(?:${fields})"\\s*(?::\\s*(?:"(?:\\\\.|[^"\\\\])*\\\\?)?)?$`, 'gi'),
          new RegExp(`(?:^|\\n)\\s*(?:${fields})\\s*$`, 'gi'),
          new RegExp(`(?:^|\\n)\\s*(?:${fields})\\s*:\\s*[^\\r\\n\\u2028\\u2029]*$`, 'gi'),
        ];
        for (const pattern of unfinished) for (const match of pending.matchAll(pattern)) count = Math.min(count, match.index);
        const start = pending.lastIndexOf('\n') + 1;
        if (start > 0 || lineStart) {
          const line = pending.slice(start);
          const trimmed = line.trimStart().toLowerCase();
          if (names.some(name => name.toLowerCase().startsWith(trimmed))) count = Math.min(count, start);
        }
        const spans = [...textRules.flatMap(([pattern]) => [...pending.matchAll(pattern)]),
          ...[...this.forms].flatMap(form => [...pending.matchAll(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))])];
        for (const match of spans.sort((a, b) => b.index - a.index)) {
          if (match.index < count && match.index + match[0].length > count) count = match.index;
        }
      }
      const safe = pending.slice(0, count);
      pending = pending.slice(count);
      const promptOnly = shown > 0 && new RegExp(`^\\s*(?:${fields})\\s*:\\s*$`, 'i').test(safe);
      const output = count && !promptOnly ? this.text(safe).slice(shown) : '';
      if (count) shown = 0;
      if (safe) lineStart = safe.endsWith('\n');
      const prompt = !final && (lineStart || /^[^\S\n]*\n/.test(pending)) ? new RegExp(`^(\\s*(?:${fields})\\s*:)(\\s*)`, 'i').exec(pending) : null;
      if (!prompt) return Buffer.from(output);
      const prefix = this.text(prompt[1]!) + prompt[2]!;
      const visible = prefix.slice(shown);
      shown = prefix.length;
      return Buffer.from(output + visible);
    };
    return { push: bytes => { pending += decoder.write(bytes); return flush(false); }, end: () => { pending += decoder.end(); return flush(true); } };
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
