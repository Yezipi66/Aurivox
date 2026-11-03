'use strict'
// 从 README 里提取作者自己写的用法命令，用来定位推理入口。
//
// README 的写法千差万别（有的人写 `python -m pkg.cli`，有的人写 `bash run.sh`，
// 有的人只贴一张截图），所以这里只认最明确的一种：`python -m 模块` 与 `python 脚本.py`。
// 认不出来就是认不出来，不回退到猜测：调用方拿空结果，走参数打分那条路。
//
// 不判断「这条命令是不是推理」：README 里同时写着训练、下载、webui 的启动方式很常见，
//   是不是推理由调用方对照扫描结果决定（只认那些确实出现在参数表里的文件）。

/**
 * @param {string} text README 原文
 * @returns {{modules: string[], files: string[]}} modules 是 `python -m x.y` 的形式，
 *   files 是相对路径的 .py。两者都已去重，顺序按出现先后。
 */
function entriesFromReadme (text) {
  const modules = []
  const files = []
  if (!text || typeof text !== 'string') return { modules, files }

  // python -m pkg.mod  /  python3 -m pkg.mod
  const reMod = /\bpython3?\s+-m\s+([A-Za-z_][\w.]*)/g
  let m = reMod.exec(text)
  while (m) {
    modules.push(m[1])
    m = reMod.exec(text)
  }

  // python path/to/file.py  /  python3 ./a/b.py
  //   只认 .py 结尾，`-m cli.inference` 不会被这里重复吞掉。
  const reFile = /\bpython3?\s+(?:\.\/)?([A-Za-z_][\w./-]*\.py)\b/g
  m = reFile.exec(text)
  while (m) {
    files.push(m[1].replace(/^\.\//, ''))
    m = reFile.exec(text)
  }

  return { modules: [...new Set(modules)], files: [...new Set(files)] }
}

/**
 * 把 `python -m a.b.c` 翻成可能的源文件路径：a/b/c.py 与 a/b/c/__main__.py。
 * 不做盘上探测：探测会挑中同名的别的东西，这里只给候选，由调用方与扫描结果对照。
 */
function moduleToFiles (mod) {
  const p = String(mod || '').replace(/\./g, '/')
  if (!p) return []
  return [p + '.py', p + '/__main__.py']
}

module.exports = { entriesFromReadme, moduleToFiles }
