const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codePointLength,
  findCodePointOffset,
  remapLangOverrides,
  remapPronOverrides,
  remapOverridesForSegment,
} = require('./positionOverrides');

test('code-point offsets stay aligned with Python for BMP/CJK text', () => {
  const text = '你好，这里是今日。';
  assert.equal(codePointLength(text), Array.from(text).length);
  assert.equal(findCodePointOffset(text, '今日'), 6);
});

test('language overrides only apply to the segment containing the absolute position', () => {
  const all = { '@0': 'yue', '@1': 'yue', '@7': 'ja' };
  assert.deepEqual(remapLangOverrides(all, 0, 3), { '@0': 'yue', '@1': 'yue' });
  assert.deepEqual(remapLangOverrides(all, 7, 4), { '@0': 'ja' });
  assert.equal(remapLangOverrides(all, 3, 3), undefined);
});

test('position pronunciation overrides are remapped but ordinary word overrides survive', () => {
  const all = {
    zh: { '你好': ['ni3', 'hao3'], '@0:你': ['ni3'] },
    ja: { '@7:今': ['コン'] },
  };
  assert.deepEqual(remapPronOverrides(all, 0, 3), {
    zh: { '你好': ['ni3', 'hao3'], '@0:你': ['ni3'] },
  });
  assert.deepEqual(remapPronOverrides(all, 7, 4), {
    zh: { '你好': ['ni3', 'hao3'] },
    ja: { '@0:今': ['コン'] },
  });
});

test('segment remap prevents @0 from leaking into later broker segments', () => {
  const full = '你好，这里是今日少し長い文章。';
  const cfg = {
    lang_overrides: { '@0': 'yue', '@1': 'yue' },
    pron_overrides: { yue: { '@0:你': ['nei5'], '@1:好': ['hou2'] } },
  };
  const first = remapOverridesForSegment(cfg, full, '你好，这里');
  const second = remapOverridesForSegment(cfg, full, '是今日少し長い文章。');
  assert.deepEqual(first.cfg.lang_overrides, { '@0': 'yue', '@1': 'yue' });
  assert.equal(second.cfg.lang_overrides, undefined);
  assert.equal(second.cfg.pron_overrides, undefined);
});
