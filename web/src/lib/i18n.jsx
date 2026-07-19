// Lightweight, opt-in UI localisation (item 17).
//
// Scope by design: this ONLY localises descriptive / warning / helper prose and
// secondary confirmation dialogs. Product terms stay in English everywhere
// (Fine-tune, Refine, Infer, Checkpoint, Epoch, Batch, Dataset, Model, Voice,
// CUDA / GPU / CPU, Generate, Compare, Train, Broker, …) — matching the GitHub /
// Hugging Face style of a partially-localised console.
//
// Mechanism: a tiny React context holding the active UI language ('en' | 'zh'),
// persisted in localStorage and defaulting to 'en' so nothing changes for
// existing users unless they flip the nav toggle. Components read it via
// `useT()`:
//    const { lang, t } = useT()
//    <p>{t('English text', '中文文案')}</p>          // simple strings
//    {lang === 'zh' ? <ZhBlock/> : <EnBlock/>}       // rich JSX blocks
//
// `t(en, zh)` falls back to the English string when a Chinese one is missing, so
// a partially-translated tree is always safe.
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

// Compact EN / 中文 switch for the nav bar.
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
