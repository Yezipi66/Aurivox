// 参考音频路径的输入清洗：粘贴来的引号与空格必须去掉。
//
// 后端拿这个值判「绝对还是相对」，而拼接用的是 os.path.join：
//   带着引号的 `"D:\voices\x.wav"` 首字符不是盘符，被判成相对路径，
//   于是拼成 `<项目根>\"D:\voices\x.wav"`，报出的路径与填进去的完全不像，
//   使用者只能看着一串拼接结果猜自己哪里填错了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanPathInput } from './refAudio.js'

test('资源管理器「复制为路径」带上的双引号要去掉', () => {
  assert.equal(cleanPathInput('"D:\\voices\\jkve\\标题.wav"'), 'D:\\voices\\jkve\\标题.wav')
})

test('单引号与套两层的引号同样去掉', () => {
  assert.equal(cleanPathInput("'D:\\voices\\a.wav'"), 'D:\\voices\\a.wav')
  assert.equal(cleanPathInput('"\'D:\\voices\\a.wav\'"'), 'D:\\voices\\a.wav')
})

test('首尾空格与引号一起出现时一并去掉', () => {
  assert.equal(cleanPathInput('   "D:\\voices\\a.wav"  '), 'D:\\voices\\a.wav')
})

test('只动首尾：路径中间的字符一个都不改', () => {
  // 文件名里可以有空格与括号，去掉它们会让路径指向另一个文件。
  assert.equal(cleanPathInput('"D:\\voices\\my clip (1).wav"'), 'D:\\voices\\my clip (1).wav')
  // 中间的引号既不参与成对剥离，也不被两端的兜底规则扫到。
  assert.equal(cleanPathInput('D:\\voices\\a"b.wav'), 'D:\\voices\\a"b.wav')
})

test('普通路径与相对路径原样返回', () => {
  assert.equal(cleanPathInput('D:\\voices\\a.wav'), 'D:\\voices\\a.wav')
  assert.equal(cleanPathInput('assets\\Akafuyu\\dicer_op\\x.wav'), 'assets\\Akafuyu\\dicer_op\\x.wav')
  assert.equal(cleanPathInput(''), '')
  assert.equal(cleanPathInput(null), '')
})
