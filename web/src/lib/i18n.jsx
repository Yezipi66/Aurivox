// 可选的界面本地化。只翻译说明性文字、警告与次要确认弹窗；产品术语一律保留英文
// （Fine-tune、Refine、Infer、Checkpoint、Epoch、Batch、Dataset、Model、Voice、CUDA、GPU、CPU、
// Generate、Compare、Train、Broker 等），与部分本地化的控制台一致。
// 实现是一个 React context，存当前界面语言（'en' | 'zh'），落在 localStorage，默认 'en'：
// 用户不主动点导航栏上的开关，界面保持原样。
// 组件用 useT() 读：const { lang, t } = useT()，t(en, zh) 在中文缺字时回退到英文。
import { createContext, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'tf.v1.ui.lang'
const SUPPORTED = ['en', 'zh']

function readInitial() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && SUPPORTED.includes(v)) return v
  } catch { /* ignore */ }
  return 'en'
}

const LangContext = createContext({ lang: 'en', setLang: () => {}, t: (en) => en })

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(readInitial)
  const setLang = (next) => {
    const v = SUPPORTED.includes(next) ? next : 'en'
    setLangState(v)
    try { localStorage.setItem(STORAGE_KEY, v) } catch { /* ignore */ }
  }
  useEffect(() => {
    try { document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en') } catch { /* ignore */ }
  }, [lang])
  const t = (en, zh) => (lang === 'zh' && zh != null ? zh : en)
  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  )
}

export function useT() {
  return useContext(LangContext)
}

// 导航栏上的 EN / 中文切换。
export function LangToggle() {
  const { lang, setLang } = useT()
  return (
    <div className="lang-toggle" role="group" aria-label="Interface language">
      <button
        type="button"
        className={`lang-opt ${lang === 'en' ? 'active' : ''}`}
        onClick={() => setLang('en')}
        title="English interface"
      >EN</button>
      <button
        type="button"
        className={`lang-opt ${lang === 'zh' ? 'active' : ''}`}
        onClick={() => setLang('zh')}
        title="中文界面（仅翻译说明性文字，专业术语保留英文）"
      >中文</button>
    </div>
  )
}
