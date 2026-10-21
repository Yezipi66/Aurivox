import React from 'react'

// 错误边界：某个组件渲染出错时只坏掉它那一块，顶栏与其他页面照常可用。
// 没有这一层时 React 会卸载整棵组件树，用户只看到白屏，报错也指不出是哪一块。
//
// 用 class 组件：componentDidCatch / getDerivedStateFromError 只有 class 才有。
//
// 不读语言上下文：出错时上下文可能已经损坏，再去读会二次抛错。
// 语言从 localStorage 直接读，读不到就退回英文。
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
    // 打到控制台便于开发时定位，不弹给用户：提示里已经说清楚了。
    if (typeof console !== 'undefined') console.error(this.props.label, err, info)
  }

  render () {
    if (this.state.err) {
      const zh = readLang() === 'zh'
      const label = this.props.label || (zh ? '此区域' : 'This section')
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
