import { useRef } from 'react'
import { useT } from '../../lib/i18n'
import { normalizeAssignments, assignmentList, LANG_LABEL } from '../../lib/hanLanguage'
import { HanLangPicker, HanFinalPreview } from './HanReview'
import { PronPanel } from './PronPanel'
import { langName } from './PronProofing'

// One modal that houses BOTH the per-character language picker and reading
// proofing, so the page keeps only a compact trigger button (no tall panels).
// ：新增 `engineId`，一路传到两个会发 /pron/preview 的孩子。
//   4 个渲染点都必须传，漏一个的表现是"那个页面的读音预览安静地不工作"。
//   `pronEngineId.node.test.js` 有一条守卫逐个点名盯着它们。
function TextPrepModal({ onClose, text, setText, panelLang, pronOverrides, setPronOverrides, hanDirection, hanForced, setHanForced, hanReadings, setHanReadings, engineId }) {
  const { t } = useT()
  const dragActiveRef = useRef(false)
  const backdropPointerDownRef = useRef(false)
  const handleBackdropPointerDown = e => {
    backdropPointerDownRef.current = e.target === e.currentTarget
  }
  const handleBackdropClick = e => {
    const close = e.target === e.currentTarget && backdropPointerDownRef.current && !dragActiveRef.current
    backdropPointerDownRef.current = false
    if (close) onClose()
  }
  const updateText = value => {
    const next = typeof value === 'function' ? value(text) : value
    if (next !== text) {
      // Absolute positions are no longer trustworthy after insertion/deletion.
      // Clear only the Han-language layer and its position-keyed readings; the
      // ordinary Reading proofing buckets remain available for the new text.
      setHanForced([])
      setHanReadings({})
    }
    setText(value)
  }
  // Characters forced to the reverse language are read in that language, so the
  // Chinese/Cantonese reading proofing below does not apply to them (they are
  // muted there). Their reading is set in the Han character language section.
  const assignmentMap = normalizeAssignments(hanForced, hanDirection, text)
  const forcedPositions = hanDirection ? assignmentList(assignmentMap, text) : []
  const mutedLangByPosition = Object.fromEntries(forcedPositions.map(pos => [pos.index, pos.lang]))
  const forcedInText = forcedPositions.map(pos => pos.char)
  return (
    <div className="modal-backdrop" onPointerDown={handleBackdropPointerDown} onClick={handleBackdropClick}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 1180, width: '94%' }}>
        <div className="modal-hdr">{t('Text preparation', '文本预处理')}</div>
        <div className="modal-body">
          <div>
            <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 6 }}>{t('Han character language', '汉字语言')}</div>
            <HanLangPicker
              text={text}
              direction={hanDirection}
              forced={hanForced}
              setForced={setHanForced}
              readings={hanReadings}
              setReadings={setHanReadings}
              onDragState={active => { dragActiveRef.current = active }}
              engineId={engineId}
            />
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 6 }}>{t('Reading proofing', '读音校对')}</div>
            {forcedInText.length > 0 && (
              <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 8 }}>
                {t(
                  `${forcedInText.join(' ')} ${forcedInText.length > 1 ? 'are' : 'is'} assigned to another Han language; the ${LANG_LABEL[panelLang] || panelLang} reading below does not apply. Set the reading in the Han character language section above.`,
                  `${forcedInText.join(' ')} 已分配给另一种汉字语言；下方的 ${langName(t, panelLang)} 读音不生效。请在上方“汉字语言”区设置读音。`,
                )}
              </div>
            )}
            <PronPanel
              text={text} setText={updateText} lang={panelLang}
              overrides={pronOverrides} setOverrides={setPronOverrides} layout="wide"
              mutedPositions={forcedPositions.map(pos => pos.index)}
              mutedLangByPosition={mutedLangByPosition}
              mutedLangLabel={hanDirection ? t('another Han language', '另一种汉字语言') : null}
              engineId={engineId}
            />
          </div>
          <HanFinalPreview text={text} direction={hanDirection} forced={hanForced} />
        </div>
        <div className="modal-ftr">
          <button className="btn" onClick={onClose}>{t('Done', '完成')}</button>
        </div>
      </div>
    </div>
  )
}

export { TextPrepModal }
