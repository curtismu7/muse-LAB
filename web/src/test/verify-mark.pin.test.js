// The vendored shared/verify-mark files (VerifyMark.jsx, VerifyMark.css) match their pin files byte for byte. They come from
// curtismu7/AI-DEMO-Standalone shared/verify-mark: change them there, re-pin, re-vendor; never edit them here.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

describe('vendored verify-mark', () => {
  it('matches VerifyMark.sha256 and VerifyMark.css.sha256', () => {
    const dir = path.join(process.cwd(), 'src', 'components');
    for (const [file, pinFile] of [['VerifyMark.jsx', 'VerifyMark.sha256'], ['VerifyMark.css', 'VerifyMark.css.sha256']]) {
      const [hash, name] = fs.readFileSync(path.join(dir, pinFile), 'utf8').trim().split(/\s+/);
      expect(name, pinFile).toBe(file);
      expect(createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex'), file).toBe(hash);
    }
  });
});
