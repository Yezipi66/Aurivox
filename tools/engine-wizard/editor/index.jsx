import React from 'react'
import { createRoot } from 'react-dom/client'
import { LangProvider } from '../../../web/src/lib/i18n'
import App from './App'
import '../../../web/src/styles.css'
import './editor.css'

// ============================================================================
//  名片编辑器 —— 独立入口
//
//  ⭐ i18n：直接用项目现成的 LangProvider（web/src/lib/i18n.jsx）
//     与主界面同一套 ⇒ 语言切换行为一致，不另造翻译表。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <LangProvider>
      <App />
    </LangProvider>
  )
}