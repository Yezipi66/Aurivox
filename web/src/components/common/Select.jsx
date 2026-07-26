// Drop-in replacement for the native <select>.
//
// WHY THIS EXISTS
// A native <select> renders its option list as an OS-level, top-most popup
// window that floats ABOVE page content *and* above in-window browser chrome
// (e.g. Edge's vertical-tab flyout). We want the opposite: the menu must be
// ordinary in-page DOM so the app fully controls its stacking/theme AND so
// browser chrome correctly paints over it. So the menu is rendered into
// document.body via a portal (never clipped by overflow ancestors) as a plain
// <div> — which, being page content, always sits below browser chrome.
//
// API is intentionally identical to <select>: pass `value`/`defaultValue`,
// `onChange` (receives `{ target: { value } }`), `className`, `style`,
// `disabled`, `title`, and <option> children (mapped, conditional or inline).
// Business logic at every call site stays byte-for-byte the same.

import {
  useState, useRef, useEffect, useCallback, useLayoutEffect,
  Children, isValidElement, Fragment,
} from 'react'
import { createPortal } from 'react-dom'

const norm = (v) => (v === undefined || v === null) ? '' : String(v)

// Extract plain text from an <option>'s children (for typeahead + display),
// recursing through arrays and nested elements.
function nodeText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText(node.props?.children)
  return ''
}

// Flatten children into option descriptors. Children.forEach already flattens
// arrays (e.g. from .map) and drops null/false (e.g. from `cond && <option/>`);
// we additionally recurse through <Fragment> and unknown wrappers defensively.
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

  // Reposition before paint + keep aligned while open (scroll/resize).
  useLayoutEffect(() => { if (open) computePos() }, [open, computePos])
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

  // Keep the highlighted option in view.
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
