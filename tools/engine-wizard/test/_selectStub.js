'use strict'
// 下拉的测试替身：渲染成原生 <select>，只承担「值与回调」这一层接线。
//
// 真实控件是页面内的 DOM 菜单（web/src/components/common/Select.jsx），
//   它的外观、定位、可打字形态由 entryChoiceRender.node.test.js 用真组件覆盖。
// 这里被替换的调用点（引擎选择、设备取值写法、参数类型等）断言的都是
//   「选了这个值之后名片 / 状态变成什么」，不需要真菜单，因此按原生下拉渲染，
//   让这些测试保持「设一个值、看结果」的直白写法。
//
// editable 那一档渲染成 <input>：值可以自由打字，本来就没有「选中某一项」这一步。
//   断言侧照旧按输入框找控件（aria-label / placeholder / disabled / value），
//   与真组件里那个输入框对得上。
const { resolveFromRoot } = require('../../../lib/testDeps.js')

const React = require(resolveFromRoot('react'))

function SelectStub (props) {
  const {
    value, defaultValue, onChange, children, className, style, disabled, id, title,
    editable, inputProps, placeholder,
  } = props

  if (editable) {
    const p = {
      ...(inputProps || {}),
      className, style, disabled, id, title, placeholder,
      value: value === undefined ? '' : value,
      onChange: (e) => { if (onChange) onChange({ target: { value: e.target.value } }) },
    }
    return React.createElement('input', p)
  }

  const p = {
    className, style, disabled, id, title,
    onChange: (e) => { if (onChange) onChange({ target: { value: e.target.value } }) },
  }
  if (value !== undefined) p.value = value
  else if (defaultValue !== undefined) p.defaultValue = defaultValue
  return React.createElement('select', p, children)
}

module.exports = SelectStub
