import React from 'react'

// ---------------------------------------------------------------------------
// 错误边界：一个零件烧了，不要整屋断电。
//
// 为什么需要它：主应用里任何一个页面组件渲染出错（例如某台引擎的名片
// 字段是它没见过的形状），React 会把整棵组件树卸载，用户看到的是白屏，
// 报错也指不出是哪台引擎、哪个字段。包一层之后，出错的那一块显示
// 「这块坏了 + 原因」，顶栏和其他页面照常可用。
//
// 为什么是 class：componentDidCatch / getDerivedStateFromError 只有
// class 组件才有，函数组件拿不到这两个钩子。
//
// 不调 useT：出错时 React 上下文可能已经损坏，再去读语言设置会二次抛错。
// 语言从 localStorage 直接读，读不到就退回英文。
// ---------------------------------------------------------------------------

function readLang () {
  try {
    const raw = localStorage.getItem('tf.v1.ui.lang') || '"en"'
    return JSON.parse(raw) === 'zh' ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export class ErrorBoundary extends React.Component {
  constructor (props) {
    super(props)
    this.state = { err: null }
  }

  static getDerivedStateFromError (err) {
    return { err }
  }

  componentDidCatch (err, info) {
    // 打到控制台便于开发时定位，但不弹给用户。提示里已经说清楚了。
    if (typeof console !== 'undefined') console.error(this.props.label, err, info)
  }

  render () {
    if (this.state.err) {
      const zh = readLang() === 'zh'
      const label = this.props.label || (zh ? '这一块' : 'This section')
      return (
        <div className="empty-state" style={{ textAlign: 'left' }}>
          <div className="es-title">
            {zh ? `${label} 加载失败` : `${label} failed to load`}
          </div>
          <div className="es-sub" style={{ marginBottom: 0 }}>
            {zh
              ? '这是平台自身的缺陷，与名片内容无关。顶栏与其他页面仍可使用，可切换到别的页面继续，或刷新重试。'
              : 'This is a platform bug, unrelated to your manifest. The nav bar and other pages still work; switch pages or reload to retry.'}
          </div>
          <div className="field-hint" style={{ marginTop: 8, wordBreak: 'break-word' }}>
            {String(this.state.err.message || this.state.err)}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
