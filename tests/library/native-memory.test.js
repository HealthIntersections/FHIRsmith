const { trimNativeMemory, canTrimNativeMemory } = require('../../library/native-memory');

describe('native-memory', () => {
  test('malloc_trim where there is one (Linux, glibc, koffi); null elsewhere', () => {
    const can = canTrimNativeMemory();
    expect(typeof can).toBe('boolean');
    const r = trimNativeMemory();
    if (can) {
      expect(typeof r).toBe('boolean');
    } else {
      expect(r).toBeNull();
    }
    if (process.platform === 'linux' && process.report.getReport().header.glibcVersionRuntime) {
      expect(can).toBe(true);
    }
  });

  test('frees nothing that is in use', () => {
    const b = Buffer.alloc(64 * 1024 * 1024, 7);
    trimNativeMemory();
    expect(b[0]).toBe(7);
    expect(b[b.length - 1]).toBe(7);
  });
});
