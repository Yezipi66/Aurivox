// 验收一批注释重写：逐个 worktree 检查，然后汇总。
// 用法：node tools/dev/verify-batch.cjs <worktree前缀> <批次号...>
//   例：node tools/dev/verify-batch.cjs D:/tmp/cb 01 02 03
const { execFileSync } = require('node:child_process')
const fs = require('fs')
const path = require('path')

const CB = path.resolve(process.env.LOCALAPPDATA, 'hermes/profiles/aurivox/cache/scratch/cb')
const prefix = process.argv[2] || 'D:/tmp/cb'
const batches = process.argv.slice(3)

let allOk = true
for (const b of batches) {
  const wt = `${prefix}${b}`
  const listPath = path.join(CB, `batch${b}.txt`)
  if (!fs.existsSync(listPath)) {
    console.log(`batch${b}: 清单文件不存在 ${listPath}`)
    allOk = false
    continue
  }
  const files = fs.readFileSync(listPath, 'utf8').trim().split('\n')

  // 1. 改动的文件是否只有清单里的那些
  //    worktree checkout 会把 CRLF 转成 LF，于是 deploy.bat 这类文件
  //    在 git status 里显示为已改，内容其实一字没变。
  //    判据：把行尾统一后与 HEAD 的内容逐字相比，一样就当没改。
  let changed
  try {
    const raw = execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })
      .split('\n').filter(Boolean)
    changed = []
    for (const line of raw) {
      const rel = line.slice(3).trim().replace(/\\/g, '/')
      if (rel.endsWith('deploy.bat') || rel.endsWith('.bat')) {
        let same = false
        try {
          const now = fs.readFileSync(path.join(wt, rel), 'utf8').replace(/\r\n/g, '\n')
          const head = execFileSync('git', ['show', 'HEAD:' + rel],
            { cwd: wt, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).replace(/\r\n/g, '\n')
          same = now === head
        } catch (e) { /* 读不到就当它改过 */ }
        if (same) continue
      }
      changed.push(rel)
    }
  } catch (e) {
    console.log(`batch${b}: 读不到 worktree ${wt}`)
    allOk = false
    continue
  }
  const extra = changed.filter((c) => !files.includes(c))

  // 2. token 比对
  let verifyOut = ''
  let verifyCode = 0
  try {
    verifyOut = execFileSync('node',
      ['tools/dev/verify-comment-only.cjs', 'HEAD', ...files],
      { cwd: wt, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (e) {
    verifyOut = (e.stdout || '') + (e.stderr || '')
    verifyCode = e.status === undefined ? 1 : e.status
  }
  const sameCount = (verifyOut.match(/\tsame\t/g) || []).length
  const diffFiles = (verifyOut.match(/\tDIFF\t/g) || []).length

  // 3. 注释占比
  let ratios = {}
  try {
    const r = execFileSync('node', ['tools/dev/comment-ratio.cjs', '25'],
      { cwd: wt, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of r.split('\n').slice(1)) {
      const [pct, rel] = line.split('\t')
      if (rel) ratios[rel] = Number(pct)
    }
  } catch (e) { /* 忽略 */ }

  const stillOver = files.filter((f) => (ratios[f] || 0) >= 25)
  const ok = diffFiles === 0 && extra.length === 0 && changed.length === files.length
  if (!ok) allOk = false

  console.log(`\n=== batch${b} (${files.length} 个文件) ===`)
  console.log(`  改动文件数: ${changed.length}（期望 ${files.length}）`)
  console.log(`  token 比对: same ${sameCount} / DIFF ${diffFiles}`)
  console.log(`  仍 >= 25% 的: ${stillOver.length}`)
  if (extra.length) console.log(`  越界改动的文件: ${extra.join(', ')}`)
  if (diffFiles) {
    for (const line of verifyOut.split('\n')) {
      if (line.includes('\tDIFF\t')) console.log('    ' + line)
    }
  }
  if (stillOver.length) {
    console.log('    ' + stillOver.map((f) => `${f}=${ratios[f]}%`).join('  '))
  }
  console.log(`  结论: ${ok ? '通过' : '有问题'}`)
}
console.log('\n' + (allOk ? '全部批次通过' : '有批次需要处理'))
process.exit(allOk ? 0 : 1)
