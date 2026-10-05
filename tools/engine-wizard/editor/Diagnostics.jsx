import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  检查结果面板
//
//  ⭐ 三档：错误 / 警告 / 提示
//      —— 「警告」那一档是本工具存在的理由：平台管不到「填了没效果」。
//
//  ⭐ 形态：**项目的** .collapsible > .collapsible-hdr + .collapsible-body，
//     默认展开 —— 检查结果是这里的核心信息，藏起来等于没有。
//     ⛔ 每一档一条都用项目现成的 .msg + .badge，
//        ⛔⛔ 不再自造一整套 .dg-*（那是重画项目的 .msg ⇒ 两套事实）。
//
//  ⛔⛔ 措辞纪律：不用口语。每句话只陈述**事实**：什么字段、缺什么、改成什么。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const LEVELS = {
  error: { zh: '错误', en: 'Error' },
  warn: { zh: '警告', en: 'Warning' },
  info: { zh: '提示', en: 'Notice' },
}

const BADGE = { error: 'badge-danger', warn: 'badge-warn', info: 'badge-info' }
const BAR = { error: 'msg-danger', warn: 'msg-warn', info: 'msg-info' }

function whereText (d) {
  if (d.section === 'parameters' && d.index !== null && d.index !== undefined) {
    return `parameters[${d.index}]${d.field ? ' · ' + d.field : ''}`
  }
  if (d.section && d.field && d.section !== d.field) return `${d.section} · ${d.field}`
  return d.section || d.field || ''
}

export default function Diagnostics ({ result, loading }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(true)   // ⭐ 默认展开

  // 还没跑出结果：连标题都不占地方
  if (loading && !result) {
    return <p className="field-hint" style={{ margin: 0 }}>{t('Checking…', '正在检查…')}</p>
  }
  if (!result) return null

  // ---- 输入本身坏了：如实说，不装作「没有诊断 = 通过」----
  const broken = result.parse_error || result.error
  if (broken) {
    return (
      <div className="collapsible">
        <div className="collapsible-hdr" onClick={() => setOpen(!open)}>
          <span>{t('Check result', '检查结果')}</span>
          <span className="badge badge-danger">1 {t('Error', '错误')}</span>
          <span className="field-hint" style={{ marginTop: 0 }}>{open ? '▲' : '▼'}</span>
        </div>
        {open && (
          <div className="collapsible-body">
            <div className="msg msg-danger">
              {result.parse_error
                ? t('Invalid JSON — the preview on the right is the previous version',
                    'JSON 无法解析 —— 右侧显示的是上一次的结果')
                : t('The checker itself failed. This says nothing about your manifest.',
                    '检查器自身出错。这与你的名片是否正确无关。')}
              <div className="field-hint">{broken}</div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const diagnostics = result.diagnostics || []
  const errors = diagnostics.filter((d) => d.level === 'error')
  const warns = diagnostics.filter((d) => d.level === 'warn')
  const infos = diagnostics.filter((d) => d.level === 'info')

  // ---- 标题上的计数：一眼看出有几类问题 ----
  const chips = []
  if (errors.length) chips.push({ cls: 'badge-danger', n: errors.length, label: t('Error', '错误') })
  if (warns.length) chips.push({ cls: 'badge-warn', n: warns.length, label: t('Warning', '警告') })
  if (infos.length) chips.push({ cls: 'badge-info', n: infos.length, label: t('Note', '说明') })
  if (!chips.length) chips.push({ cls: 'badge-ok', n: 0, label: t('No problems', '无问题') })

  return (
    <div className="collapsible">
      <div className="collapsible-hdr" onClick={() => setOpen(!open)}>
        <span>{t('Check result', '检查结果')}</span>
        {chips.map((c) => (
          <span key={c.label} className={`badge ${c.cls}`}>{c.n} {c.label}</span>
        ))}
        <span className="field-hint" style={{ marginTop: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="collapsible-body">
          {/* ⭐ 免责说明：它对**每一张名片**都成立，与当前填得好不好无关
              ⇒ 常驻一行，⛔ 不混进错误/警告里冒充一条问题。 */}
          <p className="msg msg-info">
            {t('A passing check here means the schema is accepted. '
              + 'It does not mean the engine will run, and it does not mean '
              + 'the value bindings are correct — that needs a real synthesis run.',
              '此处通过检查，表示名片结构被接受。'
              + '这不代表引擎能运行，也不代表参数绑定正确 —— 后者需要真跑一次合成来确认。')}
          </p>

          {errors.length > 0 && (
            <div className="msg msg-danger">
              {t(`${errors.length} problem(s) must be fixed before the manifest loads`,
                `${errors.length} 处问题会导致名片无法加载`)}
            </div>
          )}
          {!errors.length && warns.length > 0 && (
            <div className="msg msg-warn">
              {t(`${warns.length} item(s) may have no effect as written`,
                `${warns.length} 处按当前写法可能不生效`)}
            </div>
          )}
          {!diagnostics.length && (
            <div className="msg msg-ok">
              {t('No problems found. That is not the same as verified.',
                '未发现问题。这与「已验证」不是一回事。')}
            </div>
          )}

          {diagnostics.map((d, i) => <Diag key={i} d={d} />)}
        </div>
      )}
    </div>
  )
}

function Diag ({ d }) {
  const { t } = useT()
  const meta = LEVELS[d.level] || LEVELS.info
  // ⛔ 回落也走 t()：直接写 meta.zh 会在英文界面里漏出中文
  const tag = t(meta.en, meta.zh)
  const where = whereText(d)
  return (
    <div className={`msg ${BAR[d.level] || 'msg-info'}`}>
      <span className={`badge ${BADGE[d.level] || 'badge-info'}`}>{tag}</span>
      {' '}
      {where ? <code>{where}</code> : null}
      {' '}
      {d.message}
    </div>
  )
}
