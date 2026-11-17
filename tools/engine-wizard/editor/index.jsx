import React from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { LangProvider, useT } from '../../../web/src/lib/i18n'
import App from './App'
import { createConnGuard } from './connGuard'
import '../../../web/src/styles.css'
import './editor.css'

// 名片编辑器入口：把 App 挂到 #root，并用 LangProvider 包住它。
// i18n 直接用项目现成的 LangProvider（web/src/lib/i18n.jsx）
//     与主界面同一套 ⇒ 语言切换行为一致，不另造翻译表。
// 样式引入主界面 styles.css 与本目录 editor.css 两份，不重写组件库。

// 取数统一经过连接看守：服务未启动时，界面各处只会各自沉默地 catch 掉，
// 使用者看到的是一句 Failed to fetch。看守把这类失败集中起来，说清是哪一条
// 地址连不上，并在服务恢复后自动撤掉提示。
// 看守拿到的必须是原始 fetch：它自己被装成 window.fetch，再调 window.fetch 会自己套自己。
const realFetch = window.fetch.bind(window)
const guard = createConnGuard({ fetch: realFetch })
window.fetch = guard.fetch

function ConnBanner () {
  const { t } = useT()
  const [down, setDown] = React.useState(null)
  // 提示条占文档流：插进 App 顶部的 #wz-conn-slot，内容整体下移一格。
  //   浮层两条路都走不通：要么盖住中栏正在编辑的表单，要么被祖先的包含块裁掉。
  const [slot, setSlot] = React.useState(null)
  React.useEffect(() => guard.subscribe(setDown), [])
  React.useEffect(() => { setSlot(document.getElementById('wz-conn-slot')) }, [])
  if (!down || !slot) return null
  return createPortal(
    <div className="msg msg-error wz-conn-banner" role="alert">
      <div className="wz-conn-title">
        {t('Disconnected from the wizard service', '与向导服务断开')}
      </div>
      <div className="wz-conn-body">
        {t('Requests keep failing. Retrying every 3 seconds; this notice clears once the service answers.',
          '请求会持续失败，系统每 3 秒自动重连；服务恢复后提示自动消失。')}
      </div>
      {down.url && (
        <div className="wz-conn-url" title={down.url}>
          {t('Last failed: ', '最后失败：')}<code>{down.url}</code>
        </div>
      )}
    </div>,
    slot
  )
}

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <LangProvider>
      <App />
      <ConnBanner />
    </LangProvider>
  )
}
