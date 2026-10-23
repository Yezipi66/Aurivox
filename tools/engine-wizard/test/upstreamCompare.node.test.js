'use strict'
// 上游比对（compareUpstream）：核心判据是「这个目录自己是不是仓库根」。
// 判据要严是因为 git 会向上找 .git：engines/ 下一个普通目录（不是仓库）向上找，
// 会找到 Aurivox 自己的 .git，于是 remote.origin.url 读出来是 Aurivox 的地址，
// 而不是那个目录的来历。读之前必须先确认 show-toplevel 就是这个目录本身。
// 另一条要守的：仓库损坏时（packed-refs 损坏、对象签名不对），origin 仍要能读出来，
// 因为那是配置文件里的字，不依赖对象库。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { compareUpstream, normalizeRepoUrl, readGitIdentity } =
  require('../core/clone.js')

/** 夹具造在 os.tmpdir() 里，不碰真的 engines/。
 *  变量名里带 mkdtemp 是给 lib/engines/enginesDirWriteGuard.node.test.js 看的：
 *  那个守卫区分真假只认实参里有没有临时目录的痕迹。 */
function makeRoot (mkdtempDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-upstream-'))
  fs.mkdirSync(path.join(root, 'engines'), { recursive: true })
  return { root, engines: path.join(root, 'engines') }
}

/** 在目录里造一个 git 仓库，origin 指向给定的地址 */
function makeRepo (dir, origin) {
  fs.mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  if (origin) {
    spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, encoding: 'utf8' })
  }
  return dir
}

test('地址归一化：不同写法要归到同一个', () => {
  const want = 'github.com/owner/repo'
  for (const u of [
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo',
    'http://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://GitHub.com/Owner/Repo.git',
    'git+https://github.com/owner/repo.git',
  ]) {
    assert.strictEqual(normalizeRepoUrl(u), want, `归一化不一致：${u}`)
  }
})

test('地址归一化：空与垃圾输入不许抛', () => {
  for (const bad of [null, undefined, '', '   ', 'not a url']) {
    assert.doesNotThrow(() => normalizeRepoUrl(bad))
  }
})

test('同一个上游 ⇒ same', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), 'https://github.com/owner/repo.git')
  const r = compareUpstream(dir, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'same')
  assert.strictEqual(r.local, 'github.com/owner/repo')
  assert.strictEqual(r.upstream, 'github.com/owner/repo')
})

test('另一个上游 ⇒ different', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), 'https://github.com/other/repo.git')
  const r = compareUpstream(dir, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'different')
})

test('不是 git 仓库 ⇒ unknown，不许编一个上游', () => {
  const { engines } = makeRoot()
  const dir = path.join(engines, 'plain')
  fs.mkdirSync(dir, { recursive: true })
  const r = compareUpstream(dir, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'unknown')
  assert.strictEqual(r.local, null)
})

test('仓库没有 origin ⇒ unknown', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), null)
  const r = compareUpstream(dir, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'unknown')
})

test('目录不存在 ⇒ unknown，不许抛', () => {
  const { engines } = makeRoot()
  const r = compareUpstream(path.join(engines, 'nope'),
    'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'unknown')
})

test('没有给上游地址 ⇒ unknown', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), 'https://github.com/owner/repo.git')
  const r = compareUpstream(dir, null)
  assert.strictEqual(r.match, 'unknown')
})

// 父仓库陷阱：目录不是仓库，但它在另一个仓库里面，git 向上找会找到那个仓库。
// 判据必须用 show-toplevel 认出「这个目录自己不是仓库根」。

test('目录嵌在别的仓库里 ⇒ 当成不是仓库，不许读到父仓库的 origin', () => {
  const { root, engines } = makeRoot()
  // 造一个父仓库，origin 指向父仓库自己
  makeRepo(root, 'https://github.com/parent/repo.git')
  // 在它里面造一个普通目录
  const plain = path.join(engines, 'plain')
  fs.mkdirSync(plain, { recursive: true })

  const r = compareUpstream(plain, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'unknown',
    '读到了父仓库的 origin 就会得出错误的结论')
  assert.strictEqual(r.local, null)
})

test('父仓库陷阱：readGitIdentity 也要认出来', () => {
  const { root, engines } = makeRoot()
  makeRepo(root, 'https://github.com/parent/repo.git')
  const plain = path.join(engines, 'plain')
  fs.mkdirSync(plain, { recursive: true })

  const id = readGitIdentity(plain)
  assert.strictEqual(id.isRepo, false)
  assert.strictEqual(id.origin, null)
})

// 仓库损坏：refs 坏了不代表 origin 读不出来。
// origin 在 .git/config 里，是纯文本，不依赖对象库。

test('仓库的 refs 坏了，origin 仍要能读出来', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), 'https://github.com/owner/repo.git')
  // 写坏 packed-refs
  fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), '# pack-refs with: peeled\n\x00\x00\x00\x00\n')

  const r = compareUpstream(dir, 'https://github.com/owner/repo.git')
  assert.strictEqual(r.match, 'same',
    'refs 坏了不该影响 origin 的判定：origin 在 config 里，是纯文本')
})

test('仓库的 refs 坏了，HEAD 与分支读不到就如实给 null', () => {
  const { engines } = makeRoot()
  const dir = makeRepo(path.join(engines, 'x'), 'https://github.com/owner/repo.git')
  fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), '# pack-refs with: peeled\n\x00\x00\x00\x00\n')

  const id = readGitIdentity(dir)
  assert.strictEqual(id.isRepo, true)
  assert.strictEqual(id.origin, 'https://github.com/owner/repo.git')
  // 读不到就是 null，不许编一个出来
  assert.ok(id.head === null || typeof id.head === 'string')
})
