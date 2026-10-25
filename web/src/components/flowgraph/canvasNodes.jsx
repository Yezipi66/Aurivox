// 流程图画布上的节点与右侧检视面板：NodeBox 画节点本体，PortList 列端口，Inspector 编辑选中项。
// 三个组件都只负责呈现，不持有流程状态：拖动、连线、改值一律通过 props 回调交给上层画布。
// 尺寸与配色取 canvasShared 与 graphModel，不在这里另算一套。
import { pickText, colourFor, describeValue } from './graphModel'
import {
  NODE_WIDTH, ROW_HEIGHT, HEADER_HEIGHT, PARAM_ROW, PORT_TOP,
  BORDER, MUTED, ACCENT, CATEGORY_COLOUR,
  RUN_COLOURS, RUN_LABELS, RUN_TEXT,
  portY, nodeHeight, sourceOf, choiceLabel, usesOf,
  buttonStyle, fieldStyle,
} from './canvasShared'
import { Panel } from './canvasChrome'

export function NodeBox({ node, definition, selected, runStatus, lang, t, onDragStart, onStartWire, onFinishWire, onDisconnect }) {
  if (!definition) {
    return (
      <div style={{ position: 'absolute', left: node.position.x, top: node.position.y, width: NODE_WIDTH, padding: 8, borderRadius: 8, border: '1px dashed var(--danger, #cf6679)', color: 'var(--danger, #cf6679)', fontSize: 'var(--fs-12)' }}>
        {t(`Unrecognised node type: ${node.type}`, `未识别的节点类型：${node.type}`)}
      </div>
    )
  }
  const height = nodeHeight(definition)
  const rows = Math.max(definition.inputs.length, definition.outputs.length)
  const paramsTop = HEADER_HEIGHT + PORT_TOP + rows * ROW_HEIGHT
  const accent = CATEGORY_COLOUR[definition.category] || CATEGORY_COLOUR.other
  return (
    <div
      onMouseDown={e => onDragStart(e, node)}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: node.position.x, top: node.position.y,
        width: NODE_WIDTH, height, borderRadius: 10, cursor: 'move', userSelect: 'none',
        background: 'linear-gradient(180deg, rgba(31,36,45,0.98) 0%, rgba(24,28,36,0.98) 100%)',
        border: `1px solid ${selected ? ACCENT : (RUN_COLOURS[runStatus] || BORDER)}`,
        boxShadow: selected
          ? `0 0 0 2px rgba(76,141,255,0.25), 0 10px 26px rgba(0,0,0,0.45)`
          : '0 6px 18px rgba(0,0,0,0.35)',
        outline: runStatus === 'suspended' ? '2px solid rgba(224,179,65,0.35)' : 'none',
      }}
    >
      <div style={{
        height: HEADER_HEIGHT, padding: '0 9px', display: 'flex', alignItems: 'center', gap: 7,
        borderBottom: `1px solid ${BORDER}`, fontSize: 'var(--fs-12)', fontWeight: 600,
        borderTop: `2px solid ${accent}`, borderTopLeftRadius: 9, borderTopRightRadius: 9,
      }}>
        <span
          title={pickText(definition.help, lang)}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{pickText(definition.label, lang, definition.type)}</span>
        {runStatus
          ? (
            <span style={{
              marginLeft: 'auto', fontSize: 'var(--fs-11)', fontWeight: 500, padding: '1px 6px', borderRadius: 9,
              whiteSpace: 'nowrap', color: RUN_TEXT[runStatus] || MUTED,
              border: `1px solid ${RUN_COLOURS[runStatus] || BORDER}`,
            }}>{pickText(RUN_LABELS[runStatus], lang, runStatus)}</span>
          )
          : (
            <span style={{
              marginLeft: 'auto', fontSize: 'var(--fs-11)', color: MUTED, padding: '1px 6px', borderRadius: 9,
              background: 'rgba(255,255,255,0.04)', whiteSpace: 'nowrap',
            }}>{node.id}</span>
          )}
      </div>

      {/* Inputs: the port, what it is called in the active language, what it
          accepts, and — the part that was missing — what is currently connected
          to it. Reading a graph should not require clicking every node. */}
      {definition.inputs.map((portDef, i) => {
        const wired = sourceOf(node, portDef.name)
        const label = pickText(portDef.label, lang, portDef.name)
        const help = pickText(portDef.help, lang)
        const typeHelp = pickText(portDef.type_help, lang, portDef.type)
        return (
          <div key={portDef.name} style={{ position: 'absolute', left: 0, top: portY(i) - 9, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-11)', maxWidth: NODE_WIDTH / 2 + 26 }}>
            <span
              // Pressing a port must never start dragging the node behind it.
              // That was the whole cause of the stuck-node bug.
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => onFinishWire(e, node.id, portDef.name, !!wired)}
              onDoubleClick={e => { e.stopPropagation(); onDisconnect(portDef.name, null) }}
              title={[
                `${label}（${portDef.name}）`,
                help,
                t(`Type: ${typeHelp}`, `类型：${typeHelp}`),
                portDef.required ? t('Required', '必填') : t('Optional', '选填'),
                portDef.multiple ? t('Accepts several connections', '支持多路输入') : '',
                wired ? t(`Connected from ${wired}. Click to disconnect.`, `来源：${wired}；单击可断开连接。`) : '',
              ].filter(Boolean).join('\n')}
              style={{
                width: 11, height: 11, marginLeft: -6, borderRadius: '50%', cursor: 'crosshair', flexShrink: 0,
                background: wired ? colourFor(portDef.type) : '#11141a',
                border: `2px solid ${colourFor(portDef.type)}`,
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{
                color: portDef.required && !wired ? 'var(--warn, #e0b341)' : 'var(--text, #d8dbe2)',
                whiteSpace: 'nowrap',
              }}>
                {label}{portDef.multiple ? ' ⋯' : ''}{portDef.required && !wired ? ' *' : ''}
              </span>
              <span style={{ display: 'block', color: MUTED, fontSize: 'var(--fs-11)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {wired ? `← ${wired}` : typeHelp}
              </span>
            </span>
          </div>
        )
      })}

      {definition.outputs.map((portDef, i) => {
        const label = pickText(portDef.label, lang, portDef.name)
        const typeHelp = pickText(portDef.type_help, lang, portDef.type)
        return (
          <div key={portDef.name} style={{ position: 'absolute', right: 0, top: portY(i) - 9, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-11)', maxWidth: NODE_WIDTH / 2 + 12 }}>
            <span style={{ minWidth: 0, textAlign: 'right' }}>
              <span style={{ color: 'var(--text, #d8dbe2)', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ display: 'block', color: MUTED, fontSize: 'var(--fs-11)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {typeHelp}
              </span>
            </span>
            <span
              onMouseDown={e => onStartWire(e, node.id, portDef.name, portDef.type)}
              // Deliberately no onMouseUp here: letting it bubble to the canvas is
              // what guarantees the gesture always gets cleared. Stopping it here
              // would recreate the very bug this change removes.
              title={[
                `${label}（${portDef.name}）`,
                pickText(portDef.help, lang),
                t(`Type: ${typeHelp}`, `类型：${typeHelp}`),
              ].filter(Boolean).join('\n')}
              style={{
                width: 11, height: 11, marginRight: -6, borderRadius: '50%', cursor: 'crosshair', flexShrink: 0,
                background: colourFor(portDef.type), border: `2px solid ${colourFor(portDef.type)}`,
              }}
            />
          </div>
        )
      })}

      {/* Settings and their current values, on the node itself. This answers
          "the seed has been changed, but the node does not show what it is". */}
      {definition.params.length > 0 && (
        <div style={{
          position: 'absolute', left: 9, right: 9, top: paramsTop,
          borderTop: `1px dashed ${BORDER}`, paddingTop: 6,
        }}>
          {definition.params.map(param => {
            const value = node.params?.[param.name]
            const shown = value === undefined ? param.default : value
            return (
              <div key={param.name} style={{ display: 'flex', gap: 6, fontSize: 'var(--fs-11)', height: PARAM_ROW, alignItems: 'center' }}>
                <span style={{ color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '52%' }}>
                  {pickText(param.label, lang, param.name)}
                </span>
                <span style={{
                  marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  color: 'var(--text, #d8dbe2)', fontVariantNumeric: 'tabular-nums',
                }}>
                  {choiceLabel(param, shown, lang)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function PortList({ title, ports, lang, t, describe }) {
  if (!ports.length) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 'var(--fs-11)', color: MUTED, marginBottom: 4 }}>{title}</div>
      {ports.map(port => {
        const state = describe(port)
        return (
          <div key={port.name} style={{ fontSize: 'var(--fs-11)', marginBottom: 6, lineHeight: 1.6 }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6,
              background: colourFor(port.type),
            }} />
            <span>{pickText(port.label, lang, port.name)}</span>
            <span style={{ color: MUTED }}>
              　{pickText(port.type_help, lang, port.type)}
              {port.required ? t('　required', '　必填') : ''}
              {port.multiple ? t('　several allowed', '　支持多路') : ''}
            </span>
            <div style={{ color: state.warn ? 'var(--warn, #e0b341)' : MUTED, marginLeft: 14 }}>
              {state.text}
            </div>
            {pickText(port.help, lang) && (
              <div style={{ color: MUTED, marginLeft: 14, opacity: 0.85 }}>{pickText(port.help, lang)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Inspector({ node, definition, graph, catalogue, lang, t, voices, onImportVoice, onChange, onDelete }) {
  if (!node || !definition) {
    return (
      <Panel title={t('Node settings', '节点设置')}>
        <div style={{ fontSize: 'var(--fs-12)', color: MUTED }}>
          {t('Select a node to edit its settings here.', '选中节点后，在此编辑其设置。')}
        </div>
      </Panel>
    )
  }
  return (
    <Panel title={`${pickText(definition.label, lang, definition.type)}　${node.id}`}>
      <div style={{ fontSize: 'var(--fs-12)', color: MUTED, marginBottom: 10, lineHeight: 1.7 }}>
        {pickText(definition.help, lang)}
        <div style={{ fontSize: 'var(--fs-11)', marginTop: 4, opacity: 0.8 }}>{definition.type}</div>
      </div>

      <PortList
        title={t('Inputs', '输入')}
        ports={definition.inputs}
        lang={lang}
        t={t}
        describe={port => {
          const from = sourceOf(node, port.name)
          if (from) return { text: t(`from ${from}`, `来源：${from}`), warn: false }
          if (port.required) return { text: t('not connected', '未连接'), warn: true }
          return { text: t('not connected (optional)', '未连接（选填）'), warn: false }
        }}
      />
      <PortList
        title={t('Outputs', '输出')}
        ports={definition.outputs}
        lang={lang}
        t={t}
        describe={port => ({ text: usesOf(graph, catalogue, node.id, port.name, t), warn: false })}
      />

      <div style={{ fontSize: 'var(--fs-11)', color: MUTED, margin: '12px 0 6px' }}>{t('Settings', '设置')}</div>
      {definition.params.length === 0 && (
        <div style={{ color: MUTED, fontSize: 'var(--fs-12)' }}>
          {t('This node has no configurable settings.', '该节点没有可配置项。')}
        </div>
      )}
      {definition.params.map(param => {
        const value = node.params?.[param.name]
        const isBool = typeof param.default === 'boolean'
        const isNumber = typeof param.default === 'number'
        const isLong = param.name === 'text'
        // A server-owned list (voices) beats a fixed one, and both beat asking
        // someone to type an id they have no way of knowing.
        const fromServer = param.source === 'voices'
          ? (voices || []).map(v => ({
            value: v.id,
            label: { en: `${v.display_name || v.id}${v.language ? ` · ${v.language}` : ''}`, zh: `${v.display_name || v.id}${v.language ? ` · ${v.language}` : ''}` },
          }))
          : []
        const choices = param.choices?.length ? param.choices : fromServer
        // The voice list may be empty because nothing is saved yet or because
        // the broker is unreachable; either way a text box is still usable.
        const asDropdown = choices.length > 0
        return (
          <label key={param.name} style={{ display: 'block', marginBottom: 12, fontSize: 'var(--fs-12)' }}>
            <div style={{ marginBottom: 3 }}>{pickText(param.label, lang, param.name)}</div>
            {pickText(param.help, lang) && (
              <div style={{ color: MUTED, fontSize: 'var(--fs-11)', marginBottom: 5, lineHeight: 1.6 }}>
                {pickText(param.help, lang)}
              </div>
            )}
            {asDropdown ? (
              <select
                value={value === null || value === undefined ? (param.source ? '' : param.default) : value}
                onChange={e => onChange(param.name, e.target.value === '' ? null : e.target.value)}
                style={fieldStyle}
              >
                {param.source && <option value="">{t('(server default)', '（服务器默认）')}</option>}
                {choices.map(choice => (
                  <option key={String(choice.value)} value={choice.value}>
                    {pickText(choice.label, lang, String(choice.value))}
                  </option>
                ))}
              </select>
            ) : isBool ? (
              <input type="checkbox" checked={!!value} onChange={e => onChange(param.name, e.target.checked)} />
            ) : isLong ? (
              <textarea value={value ?? ''} rows={4} onChange={e => onChange(param.name, e.target.value)} style={fieldStyle} />
            ) : (
              <input
                value={value === null || value === undefined ? '' : value}
                onChange={e => {
                  const raw = e.target.value
                  if (raw === '') return onChange(param.name, null)
                  onChange(param.name, isNumber && raw !== '-' && !Number.isNaN(Number(raw)) ? Number(raw) : raw)
                }}
                style={fieldStyle}
              />
            )}
            <div style={{ color: MUTED, fontSize: 'var(--fs-11)', marginTop: 4 }}>
              {t(`default: ${describeValue(param.default, 'en')}`, `默认值：${describeValue(param.default, 'zh')}`)}
            </div>
            {param.source === 'voices' && (
              <>
                <button
                  type="button"
                  disabled={!value}
                  onClick={() => onImportVoice(value)}
                  style={{ ...buttonStyle, marginTop: 6, width: '100%', opacity: value ? 1 : 0.5 }}
                >
                  {t('Fill engine parameters from this voice', '按该音色填充引擎参数')}
                </button>
                <div style={{ color: MUTED, fontSize: 'var(--fs-11)', marginTop: 4, lineHeight: 1.6 }}>
                  {t(
                    'A voice is a preset: its values are copied into the engine-parameters node once and stay editable. Nothing is written back to the voice.',
                    '音色是一份预设：其参数值会一次性复制到引擎参数节点，之后仍可手动修改；修改不会写回音色。',
                  )}
                </div>
              </>
            )}
          </label>
        )
      })}
      <button onClick={onDelete} style={{ ...buttonStyle, borderColor: 'var(--danger, #cf6679)', color: 'var(--danger, #cf6679)' }}>
        {t('Delete this node (Del)', '删除该节点（Del）')}
      </button>
    </Panel>
  )
}
