import React from 'react'
import { createRoot } from 'react-dom/client'
import { LangProvider } from '../../../web/src/lib/i18n'
import App from './App'
import '../../../web/src/styles.css'
import './editor.css'

// 名片编辑器入口：把 App 挂到 #root，并用 LangProvider 包住它。
// i18n 直接用项目现成的 LangProvider（web/src/lib/i18n.jsx）
//     与主界面同一套 ⇒ 语言切换行为一致，不另造翻译表。
// 样式引入主界面 styles.css 与本目录 editor.css 两份，不重写组件库。

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <LangProvider>
      <App />
    </LangProvider>
  )
}