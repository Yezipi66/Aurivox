// 原生 <select> 的替代组件：选项菜单渲染成页面内的普通 DOM，样式与层级由本应用掌控。
// 原生下拉的选项列表是操作系统级的置顶弹窗，会盖住页面内容，也会盖住浏览器自身的界面
// （例如浏览器侧边栏），而且不受页面样式控制。改成挂到 document.body 上的普通 <div>，
// 它属于页面内容，永远在浏览器界面之下，也不会被祖先的 overflow 裁掉。
// 接口与原生 <select> 一致：value / defaultValue、onChange（收到 { target: { value } }）、
// className、style、disabled、title，以及 <option> 子元素（映射、条件或内联写法都认）；
// 另加一个 placeholder，在没有选项匹配上时显示它。
// 调用点的业务逻辑不需要改。

import {
  useState, useRef, useEffect, useCallback, useLayoutEffect,
  Children, isValidElement, Fragment,
} from 'react'
import { createPortal } from 'react-dom'

const norm = (v) => (v === undefined || v === null) ? '' : String(v)

// 取 <option> 子元素的纯文本，供输入前缀匹配用；数组与嵌套元素都递归展开。
function nodeText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText(node.props?.children)
  return ''
}

// 把子元素摊平成选项描述。Children.forEach 已经摊平了数组（例如 .map 的结果），
// 也会丢掉 null / false（例如 cond && <option/> 的结果）；这里再递归处理 <Fragment>
// 与未知的包裹元素。
function collectOptions(children, out) {
  Children.forEach(children, (child) => {
    if (child == null || typeof child === 'boolean') return
    if (!isValidElement(child)) return
    if (child.type === Fragment) { collectOptions(child.props.children, out); return }
    if (child.type === 'option') {
      out.push({
        value: child.props.value,
        label: child.props.children,
        disabled: !!child.props.disabled,
        title: child.props.title,
      })
      return
    }
    if (child.props && child.props.children) collectOptions(child.props.children, out)
  })
}

export function Select({
  value, defaultValue, onChange,
  className = '', style, disabled = false, title, id, placeholder,
  children, ...rest
}) {
  const options = []
  collectOptions(children, options)

  const isControlled = value !== undefined
  const [internal, setInternal] = useState(
    defaultValue !== undefined ? defaultValue : (options[0] ? options[0].value : '')
  )
  const current = isControlled ? value : internal
  const curNorm = norm(current)

  const selectedIdx = options.findIndex((o) => norm(o.value) === curNorm)
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null
  const displayLabel = selected ? selected.label : (placeholder ?? '')

  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(selectedIdx >= 0 ? selectedIdx : 0)
  const [pos, setPos] = useState(null)

  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const typeahead = useRef({ str: '', t: 0 })

  const computePos = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    const spaceBelow = vh - r.bottom
    const spaceAbove = r.top
    const desired = 300
    let placement = 'down'
    let maxHeight = Math.min(desired, spaceBelow - 8)
    if (spaceBelow < 200 && spaceAbove > spaceBelow) {
      placement = 'up'
      maxHeight = Math.min(desired, spaceAbove - 8)
    }
    setPos({
      left: Math.round(r.left),
      top: placement === 'down' ? Math.round(r.bottom + 4) : undefined,
      bottom: placement === 'up' ? Math.round(vh - r.top + 4) : undefined,
      minWidth: Math.round(r.width),
      maxWidth: Math.max(Math.round(r.width), Math.round(vw - r.left - 8)),
      maxHeight: Math.max(120, Math.round(maxHeight)),
      placement,
    })
  }, [])

  const firstEnabled = () => {
    for (let i = 0; i < options.length; i++) if (!options[i].disabled) return i
    return 0
  }
  const lastEnabled = () => {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i
    return options.length - 1
  }
  const nextEnabled = (from, dir) => {
    const n = options.length
    if (n === 0) return -1
    let i = from
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n
      if (!options[i].disabled) return i
    }
    return from
  }

  const openMenu = useCallback(() => {
    if (disabled) return
    computePos()
    setHi(selectedIdx >= 0 ? selectedIdx : firstEnabled())
    setOpen(true)
  }, [disabled, computePos, selectedIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((opt) => {
    if (!opt || opt.disabled) return
    if (!isControlled) setInternal(opt.value)
    onChange && onChange({ target: { value: norm(opt.value) } })
    setOpen(false)
    triggerRef.current && triggerRef.current.focus()
  }, [isControlled, onChange])

  // 绘制前先算好位置，菜单展开时也不会错位。
  useLayoutEffect(() => { if (open) computePos() }, [open, computePos])
  // 展开期间跟随滚动与窗口缩放重新定位；点击菜单与触发器之外的位置则关闭菜单。
  useEffect(() => {
    if (!open) return
    const reflow = () => computePos()
    const onDoc = (e) => {
      if (triggerRef.current && triggerRef.current.contains(e.target)) return
      if (menuRef.current && menuRef.current.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc, true)
    window.addEventListener('scroll', reflow, true)
    window.addEventListener('resize', reflow)
    return () => {
      document.removeEventListener('pointerdown', onDoc, true)
      window.removeEventListener('scroll', reflow, true)
      window.removeEventListener('resize', reflow)
    }
  }, [open, computePos])

  // 让高亮的那一项保持在可视区域内。
  useEffect(() => {
    if (!open || !menuRef.current) return
    const node = menuRef.current.querySelector(`[data-idx="${hi}"]`)
    if (node) node.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const runTypeahead = (ch) => {
    const now = Date.now()
    const ta = typeahead.current
    ta.str = (now - ta.t < 600 ? ta.str : '') + ch.toLowerCase()
    ta.t = now
    const n = options.length
    for (let k = 1; k <= n; k++) {
      const i = (hi + k) % n
      const o = options[i]
      if (!o.disabled && nodeText(o.label).toLowerCase().startsWith(ta.str)) { setHi(i); return }
    }
  }

  const onKeyDown = (e) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setHi((h) => nextEnabled(h, 1)); break
      case 'ArrowUp': e.preventDefault(); setHi((h) => nextEnabled(h, -1)); break
      case 'Home': e.preventDefault(); setHi(firstEnabled()); break
      case 'End': e.preventDefault(); setHi(lastEnabled()); break
      case 'Enter':
      case ' ': e.preventDefault(); commit(options[hi]); break
      case 'Escape': e.preventDefault(); setOpen(false); triggerRef.current && triggerRef.current.focus(); break
      case 'Tab': setOpen(false); break
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); runTypeahead(e.key) }
    }
  }

  const menu = (open && pos) ? createPortal(
    <div
      ref={menuRef}
      className="ui-select-menu"
      role="listbox"
      style={{
        position: 'fixed',
        left: pos.left,
        minWidth: pos.minWidth,
        maxWidth: pos.maxWidth,
        width: 'max-content',
        maxHeight: pos.maxHeight,
        ...(pos.placement === 'down' ? { top: pos.top } : { bottom: pos.bottom }),
      }}
    >
      {options.map((o, i) => (
        <div
          key={i}
          data-idx={i}
          role="option"
          aria-selected={i === selectedIdx}
          aria-disabled={o.disabled || undefined}
          title={o.title}
          className={
            'ui-select-option'
            + (i === hi ? ' is-active' : '')
            + (i === selectedIdx ? ' is-selected' : '')
            + (o.disabled ? ' is-disabled' : '')
          }
          onMouseEnter={() => { if (!o.disabled) setHi(i) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => commit(o)}
        >
          {o.label}
        </div>
      ))}
      {options.length === 0 && <div className="ui-select-option is-disabled">—</div>}
    </div>,
    document.body
  ) : null

  return (
    <>
      <button
        {...rest}
        type="button"
        ref={triggerRef}
        id={id}
        title={title}
        disabled={disabled}
        className={`ui-select ${className}`.trim()}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-value">{displayLabel}</span>
        <span className="ui-select-arrow" aria-hidden="true">▾</span>
      </button>
      {menu}
    </>
  )
}

export default Select
