// 语种检测。
// 根据文本中的字符集分布推断语种：汉字多于拉丁字母时按日文/韩文/中文细分，否则判为英文。
function detectLang(text) {
  const s = text.replace(/\s/g, '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length
  const en = (s.match(/[a-zA-Z]/g) || []).length
  if (cjk > en) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja'
    if (/[\uac00-\ud7af]/.test(s)) return 'ko'
    return 'zh'
  }
  return 'en'
}

export { detectLang }
