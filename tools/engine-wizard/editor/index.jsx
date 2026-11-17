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
  React.useEffect(() => guard.subscribe(setDown), [])
  if (!down) return null
  // 挂到 body，不留在 #root 里：只要某个祖先建了新的包含块（transform / contain）
  //   并带 overflow，浮层就会被那个祖先的边界裁掉，宽度与文字一起被切。
  //   挂到 body 之后它只认视口。
  return createPortal(
    <div className="msg msg-error wz-conn-banner" role="alert">
      <strong>{t('Disconnected from the wizard service.', '与向导服务断开。')}</strong>{' '}
      {t('Every request fails until it is back. The banner clears by itself once the service answers again; if it stays, check the terminal that runs vite.',
        '服务回来之前，页面上的请求都会失败。它会每三秒探一次，恢复后这条提示自动消失；一直不消失就看一眼跑 vite 的那个终端。')}
      {down.url && (
        <div className="field-hint" style={{ marginTop: 6 }}>
          {t('Last failed request: ', '最后失败的地址：')}<code>{down.url}</code>
        </div>
      )}
    </div>,
    document.body
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
