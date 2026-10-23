import { TARGET_LANG_OPTIONS } from '../../lib/langOptions'

// 对比页的目标语种选项：去掉逐段的「auto」（这一页与生成页的音色解耦），保留多语的
// auto_zh_ja_yue，供中日汉字共享的对比用。
export const CMP_LANG_OPTIONS = TARGET_LANG_OPTIONS.filter(o => o.value !== 'auto')

// 内置底模在清单里的保留 id（零样本预训练权重音色）。
export const BASE_VOICE_ID = '__base__'
