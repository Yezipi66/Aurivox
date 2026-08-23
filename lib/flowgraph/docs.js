'use strict'

// ---------------------------------------------------------------------------
//  Node documentation — one bilingual entry per node, port and setting
// ---------------------------------------------------------------------------
// Why this file exists at all:
//
//  1. A node that shows only a port name ("seed", "value", "a") tells you
//     nothing about what it wants or what it gives back. The canvas needs a
//     sentence per node, a sentence per port and a sentence per setting, or
//     wiring a graph is guesswork.
//
//  2. The interface ships in English and Chinese (web/src/lib/i18n.jsx, default
//     English). Text that lives only in the node definitions would be Chinese
//     only. So every string here is a { en, zh } pair, and the catalogue the
//     canvas reads carries both.
//
// Naming rules, applied to every label below:
//   * English is the engineering term (Seed, Threshold Gate, Loop Start).
//   * Chinese is the same term in plain, neutral wording — no jokes, no
//     conversational asides, no half-English names like "pause" / "switch"
//     sitting inside a Chinese list.
//   * Port and setting names stay in their machine form on the wire; the label
//     is what is drawn, and the tooltip always shows the machine form so the
//     screen and the error messages can be matched up.
//
// This file adds no behaviour. It is read by service.js when it describes the
// catalogue, and by docs.node.test.js, which fails if a registered node, port
// or setting has no entry here (and equally if an entry here names something
// that no longer exists).

// -- shared text -------------------------------------------------------------

const ENABLE_PORT = {
  label: { en: 'enable', zh: '启用' },
  help: {
    en: 'Optional. A 0 here means this node does not run, and neither does anything downstream of it. Leave it unwired to always run.',
    zh: '选填。输入值为 0 时，本节点及其下游节点均不执行；该端口未连接时，节点始终执行。',
  },
}

const CATEGORY_DOCS = {
  load: {
    label: { en: 'Sources', zh: '输入 / 载入' },
    help: { en: 'Where values enter the graph.', zh: '值进入流程图的地方。' },
  },
  process: {
    label: { en: 'Processing', zh: '处理' },
    help: { en: 'Nodes that turn one kind of value into another.', zh: '把一种值加工成另一种值的节点。' },
  },
  logic: {
    label: { en: 'Logic', zh: '逻辑' },
    help: { en: 'Conditions, gates and branch merging.', zh: '条件判断、闸门与分支合流。' },
  },
  loop: {
    label: { en: 'Loops', zh: '循环' },
    help: { en: 'Repeat a section of the graph and collect what each pass produced.', zh: '重复执行图的一段，并收集每一轮的产物。' },
  },
  quality: {
    label: { en: 'Quality gate', zh: '质量门' },
    help: { en: 'Measure, score, and draw the line. Measurement never gives a verdict; the threshold does.', zh: '测量、打分、划线。测量只出数字，判定由阈值节点做。' },
  },
  sink: {
    label: { en: 'Output', zh: '输出 / 落地' },
    help: { en: 'Preview, save to disk, release memory.', zh: '预览、写入磁盘、释放内存。' },
  },
  other: {
    label: { en: 'Other', zh: '其他' },
    help: { en: '', zh: '' },
  },
}

// What each port type means, so a colour on the canvas can be looked up.
const PORT_TYPE_DOCS = {
  Text: { en: 'A single piece of text.', zh: '一段文本。' },
  TextList: { en: 'Several pieces of text, in order.', zh: '按顺序排列的多段文本。' },
  Audio: { en: 'One audio clip produced by the graph.', zh: '流程图产出的一条音频。' },
  AudioList: { en: 'Several audio clips, in order.', zh: '按顺序排列的多条音频。' },
  ReferenceAudio: { en: 'An audio file on disk used as the voice reference.', zh: '磁盘上作为音色参考的音频文件。' },
  Transcript: { en: 'Recognised text with timings.', zh: '带时间信息的识别文本。' },
  Engine: { en: 'Which TTS engine to use and how to reach it.', zh: '使用哪个 TTS 引擎以及如何访问它。' },
  EngineParams: { en: 'Engine-specific settings that the synthesis node passes through untouched.', zh: '引擎专属参数，合成节点原样透传。' },
  Model: { en: 'A model, without assuming how many files it is made of.', zh: '一个模型，不限定由几个文件组成。' },
  ModelPair: { en: 'A GPT + SoVITS weight pair — one concrete kind of model.', zh: 'GPT + SoVITS 权重对，是模型的一种具体形式。' },
  VoiceRef: { en: 'A saved voice entry.', zh: '已保存的音色条目。' },
  Recipe: { en: 'The full record of how a clip was generated.', zh: '一条音频的完整生成记录（配方）。' },
  PronunciationMap: { en: 'Pronunciation corrections.', zh: '读音校正表。' },
  Metrics: { en: 'Measured numbers for one clip.', zh: '一条音频的测量数值。' },
  MetricsList: { en: 'Measured numbers for several clips.', zh: '多条音频的测量数值。' },
  Score: { en: 'A 0-100 score.', zh: '0~100 的分数。' },
  ScoreList: { en: 'Several 0-100 scores.', zh: '多个 0~100 的分数。' },
  QualityStandard: { en: 'Pass mark and weights, reusable across graphs.', zh: '及格线与权重，可跨流程图复用。' },
  Table: { en: 'A table for display.', zh: '用于展示的表格。' },
  Number: { en: 'A number.', zh: '数值。' },
  Boolean: { en: '0 or 1.', zh: '0 或 1。' },
  String: { en: 'A short string.', zh: '短字符串。' },
  IndexList: { en: 'Positions in a list, counting from 0.', zh: '列表中的位置序号，从 0 开始。' },
  Any: { en: 'Accepts any type.', zh: '接受任意类型。' },
}

// -- per-node documentation --------------------------------------------------

const NODE_DOCS = {
  // -- sources ---------------------------------------------------------------
  'io.text': {
    label: { en: 'Text', zh: '文本' },
    help: {
      en: 'Holds the text to be spoken. Type it in the settings panel on the right.',
      zh: '存放要合成的文本，在右侧设置面板中填写。',
    },
    ports: { text: { label: { en: 'text', zh: '文本' }, help: { en: 'The text exactly as typed.', zh: '原样输出所填文本。' } } },
    params: { text: { label: { en: 'Text', zh: '文本内容' }, help: { en: 'What will be spoken.', zh: '要合成的文字。' } } },
  },
  'io.reference_audio': {
    label: { en: 'Reference Audio', zh: '参考音频' },
    help: {
      en: 'Points at a voice reference file on disk. The file is checked when the graph runs, not when you type the path.',
      zh: '指向磁盘上的音色参考文件。文件在运行时检查，而不是填写时检查。',
    },
    ports: { audio: { label: { en: 'audio', zh: '参考音频' }, help: { en: 'The reference file, passed on as a path.', zh: '以路径形式传出的参考音频。' } } },
    params: {
      path: {
        label: { en: 'File path', zh: '文件路径' },
        help: { en: 'Full path to a wav/mp3 file. Missing at run time gives an error naming the file.', zh: 'wav/mp3 文件的完整路径。运行时找不到会报出具体文件名。' },
      },
    },
  },
  'io.engine_params': {
    label: { en: 'Engine Parameters', zh: '引擎参数' },
    help: {
      en: 'Supplies the optional engine_params input of the synthesis node. Settings left empty are not sent at all, so the server keeps its own default. A voice can fill this node in one action; every value it writes remains editable afterwards.',
      zh: '为合成节点的 engine_params 选填输入提供参数。留空的项不会发送，服务器沿用自身默认值。可由音色一次性填充本节点，填入的每一项之后仍可手动修改。',
    },
    ports: {
      params: {
        label: { en: 'params', zh: '参数' },
        help: { en: 'The filled-in settings, passed to the engine untouched.', zh: '已填写的参数，原样传给引擎。' },
      },
    },
    params: {
      gpt_model: {
        label: { en: 'GPT model', zh: 'GPT 模型' },
        help: { en: 'Path of the GPT checkpoint. Normally filled in by importing a voice.', zh: 'GPT 权重文件路径，通常由导入音色自动填写。' },
      },
      sovits_model: {
        label: { en: 'SoVITS model', zh: 'SoVITS 模型' },
        help: { en: 'Path of the SoVITS weights. Normally filled in by importing a voice.', zh: 'SoVITS 权重文件路径，通常由导入音色自动填写。' },
      },
      // ⛔ 这里原先还躺着 14 条引擎旋钮的说明（temperature / top_k / top_p /
      //    repetition_penalty / text_split_method / speed_factor / batch_size /
      //    batch_threshold / split_bucket / fragment_interval / parallel_infer /
      //    sample_steps / if_sr）。它们已搬进 engines/*/manifest.json 的
      //    params.schema.<键>.help —— 契约 C11：参数表只有一份。
      //
      //    ⭐ 搬走的时候顺手删掉了「服务器默认值 1.0」这类把数字抄进散文的
      //    写法。那是最阴的一种漂移：名片把默认值改了，这句话不会报错，
      //    只会开始撒谎，而看说明的人正是最没能力发现它撒谎的人。
      //
      //    留下的三条是**资产字段**（模型权重、参考音频路径），不是可调
      //    旋钮：它们没有 min/max/step，界面上长的是文件选择器不是滑块，
      //    而且是「导入音色」这个动作填的。等契约 §12 第 2 步把 cfg 词汇表
      //    去方言化时，它们会跟着那一刀走，不在这一刀里。
      aux_ref_audio_paths: {
        label: { en: 'aux_ref_audio_paths', zh: '辅助参考音频' },
        help: { en: 'Additional reference audio paths, separated by commas.', zh: '附加参考音频路径，多个路径以逗号分隔。' },
      },
    },
  },

  'io.engine': {
    label: { en: 'TTS Engine', zh: '推理引擎' },
    help: {
      en: 'Chooses which engine synthesises, which voice it uses and where it is reachable. The synthesis node itself knows nothing about any specific engine.',
      zh: '选择由哪个引擎合成、使用哪个音色、地址在哪。合成节点本身不认识任何具体引擎。',
    },
    ports: { engine: { label: { en: 'engine', zh: '引擎' }, help: { en: 'Engine id, voice and address travelling together.', zh: '引擎标识、音色与地址一并传出。' } } },
    params: {
      engine_id: {
        label: { en: 'Engine', zh: '引擎' },
        help: {
          en: 'Which engine synthesises. The list is whatever is installed on this machine under engines/; leaving it empty uses the default engine the server is configured with.',
          zh: '由哪台引擎合成。列表就是本机 engines/ 下装了的那几台；留空表示用服务器的默认引擎。',
        },
        // ⛔ 这里以前写死着 choices: [gpt-sovits]。下游作者装了自己的引擎也
        // 在画布上选不到 —— 契约 §9 把这一行列为要清掉的硬编码之一。
        // 'engines' 跟 'voices' 一个意思：候选项归服务器算，不写在这里。
        source: 'engines',
      },
      voice: {
        label: { en: 'Voice', zh: '音色' },
        help: {
          en: 'Chosen from the voices saved on this server. A voice also acts as a preset: importing one fills in the engine-parameters node, and every imported value stays editable.',
          zh: '从本机已保存的音色中选择。音色同时是一份预设：导入后会填充引擎参数节点，且导入的每一项仍可手动修改。',
        },
        source: 'voices',
      },
      base_url: {
        label: { en: 'Address', zh: '服务地址' },
        help: { en: 'Override the inference address. Empty means the address the server is already configured with.', zh: '覆盖推理服务地址；留空表示沿用服务器现有配置。' },
      },
    },
  },
  'io.number': {
    label: { en: 'Number', zh: '数值' },
    help: { en: 'A fixed number, for thresholds, counts and settings that other nodes read.', zh: '一个固定数值，用于阈值、次数等需要被其他节点读取的设置。' },
    ports: { value: { label: { en: 'value', zh: '数值' }, help: { en: 'The number as typed.', zh: '所填数值。' } } },
    params: { value: { label: { en: 'Value', zh: '数值' }, help: { en: 'Any number.', zh: '任意数值。' } } },
  },
  'io.boolean': {
    label: { en: 'Boolean', zh: '布尔值' },
    help: { en: 'A fixed 1 or 0. Wire it into an enable port to switch part of a graph off without deleting it.', zh: '固定的 1 或 0。接到 enable 口上，可在不删除节点的前提下停用图的一部分。' },
    ports: { value: { label: { en: 'value', zh: '布尔值' }, help: { en: '1 when on, 0 when off.', zh: '开为 1，关为 0。' } } },
    params: { value: { label: { en: 'On', zh: '开' }, help: { en: 'Checked sends 1, unchecked sends 0.', zh: '勾选输出 1，不勾输出 0。' } } },
  },
  'io.seed': {
    label: { en: 'Seed', zh: '随机种子' },
    help: {
      en: 'The random seed handed to synthesis. The same seed with the same settings reproduces the same clip; -1 asks the engine for a new random seed on every run, so results differ each time.',
      zh: '交给合成使用的随机种子。相同设置下相同种子可复现同一条音频；填 -1 表示每次运行都由引擎重新随机，因此每次结果都不同。',
    },
    ports: {
      seed: {
        label: { en: 'seed', zh: '种子' },
        help: { en: 'Wire this into the seed input of the synthesis node.', zh: '连接至合成节点的 seed 输入端口。' },
      },
    },
    params: {
      seed: {
        label: { en: 'Seed', zh: '种子值' },
        help: { en: '-1 = new random seed each run. Any other whole number = reproducible.', zh: '-1 表示每次运行重新随机；其他整数表示可复现。' },
      },
    },
  },

  // -- processing ------------------------------------------------------------
  'text.split': {
    label: { en: 'Split Text', zh: '文本分句' },
    help: { en: 'Cuts text into lines at sentence endings, then cuts anything still too long. Feed the lines to a loop to synthesise one sentence per pass.', zh: '在句末标点处把文本切成多行，过长的行再按长度切开。将输出连接至循环节点，即可逐句合成。' },
    ports: {
      text: { label: { en: 'text', zh: '文本' }, help: { en: 'The text to cut up.', zh: '要切分的文本。' } },
      lines: { label: { en: 'lines', zh: '分句结果' }, help: { en: 'The pieces, in order.', zh: '切分后的各段，保持原顺序。' } },
    },
    params: {
      max_chars: { label: { en: 'Max characters per line', zh: '每行最多字数' }, help: { en: 'A piece longer than this is cut again.', zh: '超过此长度的段落会被再次切开。' } },
    },
  },
  'tts.synthesize': {
    label: { en: 'Synthesize', zh: '语音合成' },
    help: {
      en: 'Turns text into audio. It needs text and an engine; a reference audio and a seed are optional but are what make a result reproducible. Engine-specific settings arrive through engine_params and are passed through untouched.',
      zh: '把文本合成为音频。必须接入文本与引擎；参考音频与种子选填，但正是它们决定结果能否复现。引擎专属设置通过 engine_params 传入并原样透传。',
    },
    ports: {
      text: { label: { en: 'text', zh: '文本' }, help: { en: 'What to say.', zh: '要合成的文字。' } },
      engine: { label: { en: 'engine', zh: '引擎' }, help: { en: 'From the TTS Engine node.', zh: '来自「推理引擎」节点。' } },
      reference_audio: { label: { en: 'reference_audio', zh: '参考音频' }, help: { en: 'Optional voice reference for this clip.', zh: '选填，本条音频使用的音色参考。' } },
      seed: { label: { en: 'seed', zh: '种子' }, help: { en: 'Optional. Unwired means the engine decides.', zh: '选填，不接则由引擎决定。' } },
      engine_params: { label: { en: 'engine_params', zh: '引擎参数' }, help: { en: 'Optional bundle of engine-specific settings (top_k, sample_steps, …).', zh: '选填，引擎专属参数包（top_k、sample_steps 等）。' } },
      audio: { label: { en: 'audio', zh: '音频' }, help: { en: 'The generated clip, carrying its own recipe.', zh: '生成的音频，自带生成配方。' } },
    },
    params: {
      format: {
        label: { en: 'Format', zh: '输出格式' },
        help: { en: 'Audio format asked of the engine.', zh: '向引擎请求的音频格式。' },
        choices: [
          { value: 'wav', label: { en: 'wav', zh: 'wav' } },
          { value: 'mp3', label: { en: 'mp3', zh: 'mp3' } },
        ],
      },
    },
  },
  'audio.concat': {
    label: { en: 'Concatenate Audio', zh: '音频拼接' },
    help: { en: 'Joins several clips into one, optionally with silence between them.', zh: '把多条音频拼成一条，可在中间插入静音。' },
    ports: {
      audios: { label: { en: 'audios', zh: '音频列表' }, help: { en: 'The clips to join, in order.', zh: '要拼接的音频，按顺序。' } },
      audio: { label: { en: 'audio', zh: '音频' }, help: { en: 'The joined clip.', zh: '拼接后的音频。' } },
    },
    params: {
      silence_ms: { label: { en: 'Silence between clips (ms)', zh: '间隔静音（毫秒）' }, help: { en: '0 joins them with no gap.', zh: '填 0 表示不留间隔。' } },
    },
  },

  // -- logic -----------------------------------------------------------------
  'logic.pause': {
    label: { en: 'Pause (human gate)', zh: '人工确认（暂停）' },
    help: {
      en: 'Stops the run and waits for an answer. Continue sends 1, Stop sends 0. It carries no data — it only decides whether the pipeline goes on.',
      zh: '暂停运行并等待答复：继续输出 1，停止输出 0。它不传递数据，只决定管线是否继续。',
    },
    ports: { value: { label: { en: 'value', zh: '结果' }, help: { en: '1 for continue, 0 for stop.', zh: '继续为 1，停止为 0。' } } },
    params: { prompt: { label: { en: 'Question', zh: '提示语' }, help: { en: 'Shown in the run panel while waiting.', zh: '等待时显示在运行面板上的问题。' } } },
  },
  'logic.select': {
    label: { en: 'Select', zh: '人工挑选' },
    help: {
      en: 'Takes a list and lets only the chosen items travel on. Wire indices to have an upstream node choose; leave it unwired and the run stops so a person can tick the ones to keep.',
      zh: '从一组候选中只放行被选中的部分。接入 indices 表示由上游节点选择；不接则暂停运行，由人勾选保留哪些。',
    },
    ports: {
      candidates: { label: { en: 'candidates', zh: '候选' }, help: { en: 'The items to choose from.', zh: '待挑选的条目。' } },
      indices: { label: { en: 'indices', zh: '序号' }, help: { en: 'Optional. Positions to keep, counting from 0.', zh: '选填，要保留的位置序号，从 0 开始。' } },
      selected: { label: { en: 'selected', zh: '选中的' }, help: { en: 'Only the chosen items.', zh: '仅包含被选中的条目。' } },
    },
    params: { prompt: { label: { en: 'Question', zh: '提示语' }, help: { en: 'Shown above the candidate list.', zh: '显示在候选列表上方的问题。' } } },
  },
  'logic.compare': {
    label: { en: 'Compare', zh: '数值比较' },
    help: { en: 'Compares two numbers and puts out 1 or 0. This is what turns a measured number into a decision.', zh: '比较两个数值并输出 1 或 0，是把测量数字变成判断的节点。' },
    ports: {
      a: { label: { en: 'a', zh: '左值' }, help: { en: 'Left-hand number.', zh: '比较符左边的数值。' } },
      b: { label: { en: 'b', zh: '右值' }, help: { en: 'Right-hand number. Unwired uses the setting below.', zh: '比较符右边的数值；不接线时使用下方设置。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 when the comparison holds.', zh: '比较成立时为 1。' } },
    },
    params: {
      op: {
        label: { en: 'Operator', zh: '比较方式' },
        help: { en: 'How a is compared with b.', zh: '左值与右值的比较方式。' },
        choices: ['>', '>=', '<', '<=', '==', '!='].map(v => ({ value: v, label: { en: v, zh: v } })),
      },
      b: { label: { en: 'b (when unwired)', zh: '右值（未接线时）' }, help: { en: 'Used only when the b input has no wire.', zh: '仅在右值输入端口未连接时使用。' } },
    },
  },
  'logic.and': {
    label: { en: 'AND', zh: '与（AND）' },
    help: { en: '1 only when both inputs are 1.', zh: '两个输入都为 1 时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.or': {
    label: { en: 'OR', zh: '或（OR）' },
    help: { en: '1 when either input is 1.', zh: '任一输入为 1 时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.not': {
    label: { en: 'NOT', zh: '非（NOT）' },
    help: { en: 'Flips 1 into 0 and 0 into 1.', zh: '将输入取反：输入 1 时输出 0，输入 0 时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入' }, help: { en: 'The condition to invert.', zh: '要取反的条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.xor': {
    label: { en: 'XOR', zh: '异或（XOR）' },
    help: { en: '1 when exactly one input is 1.', zh: '两个输入不同时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.xnor': {
    label: { en: 'XNOR', zh: '同或（XNOR）' },
    help: { en: '1 when both inputs are the same.', zh: '两个输入相同时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.nand': {
    label: { en: 'NAND', zh: '与非（NAND）' },
    help: { en: '0 only when both inputs are 1.', zh: '两个输入都为 1 时输出 0。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.nor': {
    label: { en: 'NOR', zh: '或非（NOR）' },
    help: { en: '1 only when both inputs are 0.', zh: '两个输入都为 0 时输出 1。' },
    ports: {
      a: { label: { en: 'a', zh: '输入 A' }, help: { en: 'First condition.', zh: '第一个条件。' } },
      b: { label: { en: 'b', zh: '输入 B' }, help: { en: 'Second condition.', zh: '第二个条件。' } },
      value: { label: { en: 'value', zh: '结果' }, help: { en: '1 or 0.', zh: '1 或 0。' } },
    },
    params: {},
  },
  'logic.switch': {
    label: { en: 'Switch', zh: '条件二选一' },
    help: {
      en: 'Picks one of two values according to a condition, so a branch comes back to one line instead of running off on its own.',
      zh: '按条件在两个值中选一个输出，使分支重新汇回主线，而不是各走各的。',
    },
    ports: {
      condition: { label: { en: 'condition', zh: '条件' }, help: { en: '1 picks when_true, 0 picks when_false.', zh: '为 1 取「条件成立」，为 0 取「条件不成立」。' } },
      when_true: { label: { en: 'when_true', zh: '条件成立时' }, help: { en: 'Value used when the condition is 1.', zh: '条件为 1 时输出的值。' } },
      when_false: { label: { en: 'when_false', zh: '条件不成立时' }, help: { en: 'Value used when the condition is 0.', zh: '条件为 0 时输出的值。' } },
      value: { label: { en: 'value', zh: '输出' }, help: { en: 'Whichever side was picked.', zh: '被选中的那一路的值。' } },
    },
    params: {},
  },
  'logic.sleep': {
    label: { en: 'Sleep', zh: '延时等待' },
    help: { en: 'Waits a fixed time, then puts out 1. It waits for the clock, not for a person — use Pause for that.', zh: '等待固定时长后输出 1。它等待的是固定时长，而非人工响应；如需等待人工确认，请使用「人工确认」节点。' },
    ports: {
      trigger: { label: { en: 'trigger', zh: '触发' }, help: { en: 'Optional. Anything wired here decides when the wait starts.', zh: '选填，接入任意值以决定何时开始等待。' } },
      done: { label: { en: 'done', zh: '完成' }, help: { en: '1 once the wait is over.', zh: '等待结束后输出 1。' } },
    },
    params: { ms: { label: { en: 'Wait (ms)', zh: '等待时长（毫秒）' }, help: { en: '0 does not wait at all.', zh: '填 0 表示不等待。' } } },
  },

  // -- loops -----------------------------------------------------------------
  'flow.loop_start': {
    label: { en: 'Loop Start', zh: '循环开始' },
    help: {
      en: 'Runs everything between here and the matching Loop End once per item. Wire a list to walk that list, or set a repeat count instead.',
      zh: '让本节点与对应「循环结束」之间的部分按条目逐一执行。接入列表即遍历该列表，或改为设置重复次数。',
    },
    ports: {
      list: { label: { en: 'list', zh: '列表' }, help: { en: 'Optional. The list to walk. Unwired, the repeat count is used.', zh: '选填，要遍历的列表；不接则使用重复次数设置。' } },
      item: { label: { en: 'item', zh: '本轮条目' }, help: { en: 'This pass\'s item.', zh: '当前这一轮的条目。' } },
      index: { label: { en: 'index', zh: '轮次序号' }, help: { en: 'Which pass this is, counting from 0.', zh: '当前是第几轮，从 0 开始。' } },
    },
    params: { times: { label: { en: 'Repeat count', zh: '重复次数' }, help: { en: 'Used only when no list is wired.', zh: '仅在未接入列表时使用。' } } },
  },
  'flow.loop_end': {
    label: { en: 'Loop End', zh: '循环结束' },
    help: {
      en: 'Marks where the repeated section stops. Every Append node of this loop must hang off it, which is why the body port takes several wires.',
      zh: '标记重复区段的终点。本循环的所有「结果累加」节点都要挂在这里，因此 body 口可以接多条线。',
    },
    ports: {
      body: { label: { en: 'body', zh: '循环体' }, help: { en: 'Wire the last node of each strand inside the loop here. Several wires are normal.', zh: '把循环内每条支线的末端接到这里；接多条是常态。' } },
      done: { label: { en: 'done', zh: '完成' }, help: { en: '1 after the last pass.', zh: '最后一轮结束后输出 1。' } },
    },
    params: { loop: { label: { en: 'Paired loop start', zh: '配对的循环开始' }, help: { en: 'Which Loop Start this closes. Filled in automatically.', zh: '本节点闭合的是哪个「循环开始」，通常由系统自动填写。' } } },
  },
  'flow.append': {
    label: { en: 'Append', zh: '结果累加' },
    help: {
      en: 'Collects one value per pass and publishes the whole list when the loop ends. Without it the tenth pass overwrites the ninth and only one result survives. Nothing inside the same loop may read its list.',
      zh: '每轮收集一个值，循环结束时一次性发布整个列表。若不使用本节点，后一轮的结果将覆盖前一轮，最终仅保留一个结果。同一循环内的节点不得读取它的列表。',
    },
    ports: {
      value: { label: { en: 'value', zh: '本轮的值' }, help: { en: 'What this pass produced.', zh: '当前这一轮产生的值。' } },
      list: { label: { en: 'list', zh: '汇总列表' }, help: { en: 'Everything collected, available only after the loop ends.', zh: '收集到的全部内容，仅在循环结束后可用。' } },
    },
    params: {},
  },

  // -- quality ---------------------------------------------------------------
  'quality.measure_basic': {
    label: { en: 'Acoustic Metrics (basic)', zh: '基础声学测量' },
    help: {
      en: 'Measures a clip on its own: duration, silence, clipping, loudness, speaking rate. Numbers only — it never says whether the clip is good.',
      zh: '只针对音频本身测量：时长、静音、削顶、响度、语速等。只出数字，不做好坏判断。',
    },
    ports: {
      audio: { label: { en: 'audio', zh: '待测音频' }, help: { en: 'The clip to measure.', zh: '要测量的音频。' } },
      text: { label: { en: 'text', zh: '对应文本' }, help: { en: 'Optional. Needed for speaking rate.', zh: '选填，计算语速时需要。' } },
      metrics: { label: { en: 'metrics', zh: '测量结果' }, help: { en: 'The measured numbers, travelling with the clip they describe.', zh: '测得的数值，随所描述的音频一起传递。' } },
    },
    params: { silence_db: { label: { en: 'Silence threshold (dB)', zh: '静音阈值（dB）' }, help: { en: 'Anything quieter than this counts as silence.', zh: '低于此响度即视为静音。' } } },
  },
  'quality.measure_similarity': {
    label: { en: 'Similarity Metrics', zh: '音色相似度测量' },
    help: { en: 'Compares a clip against the reference audio: pitch, spectrum and cepstral distance. Numbers only.', zh: '将音频与参考音频对比：音高、频谱、倒谱距离等。只出数字。' },
    ports: {
      audio: { label: { en: 'audio', zh: '待测音频' }, help: { en: 'The generated clip.', zh: '生成出来的音频。' } },
      reference: { label: { en: 'reference', zh: '参考音频' }, help: { en: 'What it is supposed to sound like.', zh: '作为对比基准的参考音频。' } },
      metrics: { label: { en: 'metrics', zh: '测量结果' }, help: { en: 'Distances and differences, travelling with the clip.', zh: '各项差距数值，随音频一起传递。' } },
    },
    params: {},
  },
  'quality.read_metric': {
    label: { en: 'Pick Metric', zh: '提取指标' },
    help: { en: 'Takes one named number out of a measurement so it can be scored or compared.', zh: '从测量结果中取出指定的一项数值，以便打分或比较。' },
    ports: {
      metrics: { label: { en: 'metrics', zh: '测量结果' }, help: { en: 'From a measurement node.', zh: '来自测量节点。' } },
      value: { label: { en: 'value', zh: '数值' }, help: { en: 'The chosen number.', zh: '取出的那一项数值。' } },
    },
    params: { name: { label: { en: 'Metric name', zh: '指标名称' }, help: { en: 'Which measured number to take. An unknown name errors and lists the available ones.', zh: '要取哪一项；名称不存在时会报错并列出可用项。' } } },
  },
  'quality.normalize': {
    label: { en: 'Normalise to Score', zh: '指标归一化打分' },
    help: {
      en: 'Turns a raw measurement into 0-100 so different units can be added up. Put the "good" end below the "bad" end for metrics where smaller is better.',
      zh: '把原始测量值换算成 0~100，使不同单位的指标可以相加。对于越小越好的指标，把「满分值」填得比「零分值」小即可。',
    },
    ports: {
      value: { label: { en: 'value', zh: '原始数值' }, help: { en: 'The measurement to convert.', zh: '要换算的测量值。' } },
      score: { label: { en: 'score', zh: '分数' }, help: { en: '0 to 100.', zh: '0 至 100 的分数。' } },
    },
    params: {
      good: { label: { en: 'Value worth 100', zh: '满分对应值' }, help: { en: 'The measurement that deserves full marks.', zh: '应得 100 分的测量值。' } },
      bad: { label: { en: 'Value worth 0', zh: '零分对应值' }, help: { en: 'The measurement that deserves nothing.', zh: '应得 0 分的测量值。' } },
    },
  },
  'quality.weighted_score': {
    label: { en: 'Weighted Total', zh: '加权总分' },
    help: { en: 'Combines several scores into one. The weights are your judgement, which is why they live in the graph and not in the code.', zh: '把多个分数合成一个总分。权重代表你的取舍，因此写在图上而不是写死在代码里。' },
    ports: {
      scores: { label: { en: 'scores', zh: '各项分数' }, help: { en: 'Wire one score per aspect you care about.', zh: '每个关注的方面接入一个分数。' } },
      score: { label: { en: 'score', zh: '总分' }, help: { en: 'The weighted average, 0 to 100.', zh: '加权平均后的总分，0~100。' } },
    },
    params: { weights: { label: { en: 'Weights', zh: '权重' }, help: { en: 'One weight per wired score, e.g. [2,1,1]. Empty weights them equally.', zh: '与接入分数一一对应，例如 [2,1,1]；留空表示等权。' } } },
  },
  'quality.standard': {
    label: { en: 'Quality Standard', zh: '质量标准' },
    help: { en: 'A named pass mark plus weights, so the same standard can be reused by several nodes and several graphs.', zh: '带名称的及格线与权重，可被多个节点、多张图复用。' },
    ports: { standard: { label: { en: 'standard', zh: '质量标准' }, help: { en: 'Wire this into the threshold, filter or table nodes.', zh: '接到阈值判定、列表筛选或评分表节点。' } } },
    params: {
      name: { label: { en: 'Name', zh: '名称' }, help: { en: 'What this standard is called.', zh: '该标准的名称。' } },
      pass_score: { label: { en: 'Pass mark', zh: '及格线' }, help: { en: 'Scores at or above this pass.', zh: '达到或超过该分数即为通过。' } },
      weights: { label: { en: 'Weights', zh: '权重' }, help: { en: 'Optional weights carried with the standard.', zh: '选填，随标准一起携带的权重。' } },
      limits: { label: { en: 'Limits', zh: '硬性上下限' }, help: { en: 'Optional hard limits carried with the standard.', zh: '选填，随标准一起携带的硬性上下限。' } },
    },
  },
  'quality.threshold': {
    label: { en: 'Threshold Gate', zh: '阈值判定' },
    help: {
      en: 'Compares a score with the pass mark and puts out 1 or 0. It does not retry, pick a winner or decide what happens next — wire the 0 wherever you want it to go.',
      zh: '把分数与及格线比较，输出 1 或 0。它不重试、不选优、不决定下一步；那条 0 接到哪里由你决定。',
    },
    ports: {
      score: { label: { en: 'score', zh: '分数' }, help: { en: 'The score being judged.', zh: '被判定的分数。' } },
      standard: { label: { en: 'standard', zh: '质量标准' }, help: { en: 'Optional. Overrides the pass mark below.', zh: '选填，接入后覆盖下方的及格线设置。' } },
      pass: { label: { en: 'pass', zh: '是否通过' }, help: { en: '1 when the score reaches the pass mark.', zh: '达到及格线时为 1。' } },
      score_out: { label: { en: 'score', zh: '分数' }, help: { en: 'The same score, passed on so it can be shown or stored.', zh: '原分数原样传出，便于展示或保存。' } },
    },
    params: { pass_score: { label: { en: 'Pass mark', zh: '及格线' }, help: { en: 'Used when no standard is wired.', zh: '未接入质量标准时使用。' } } },
  },
  'quality.filter_list': {
    label: { en: 'Filter List', zh: '列表筛选' },
    help: {
      en: 'Judges a whole batch at once: everything at or above the pass mark is kept, the rest is handed out separately so it can be shown or released.',
      zh: '一次判定整批候选：达到及格线的保留，其余单独输出，便于查看或释放。',
    },
    ports: {
      items: { label: { en: 'items', zh: '候选' }, help: { en: 'The batch being filtered.', zh: '被筛选的一批条目。' } },
      scores: { label: { en: 'scores', zh: '分数' }, help: { en: 'One score per item, in the same order.', zh: '与候选一一对应、顺序相同的分数。' } },
      standard: { label: { en: 'standard', zh: '质量标准' }, help: { en: 'Optional. Overrides the pass mark below.', zh: '选填，接入后覆盖下方的及格线设置。' } },
      kept: { label: { en: 'kept', zh: '保留的' }, help: { en: 'Items that passed.', zh: '通过的条目。' } },
      dropped: { label: { en: 'dropped', zh: '淘汰的' }, help: { en: 'Items that did not. Not wiring this does not delete them.', zh: '未通过的条目；该端口未连接并不表示这些条目被删除。' } },
      kept_indices: { label: { en: 'kept_indices', zh: '保留序号' }, help: { en: 'Where the kept items sat in the original list.', zh: '保留条目在原列表中的位置。' } },
      kept_count: { label: { en: 'kept_count', zh: '保留数量' }, help: { en: 'How many survived.', zh: '通过的条目数量。' } },
    },
    params: { pass_score: { label: { en: 'Pass mark', zh: '及格线' }, help: { en: 'Used when no standard is wired.', zh: '未接入质量标准时使用。' } } },
  },
  'quality.top_k': {
    label: { en: 'Sort & Top-K', zh: '排序取前 K 项' },
    help: {
      en: 'Sorts by score and keeps the best few. Optional by design: the main line is a pass mark, because the best measured clip is not automatically the best sounding one.',
      zh: '按分数排序并保留前几名。设计上属于可选路线：主线是及格线，因为客观分数最高不等于听感最好。',
    },
    ports: {
      items: { label: { en: 'items', zh: '候选' }, help: { en: 'The batch to sort.', zh: '要排序的一批条目。' } },
      scores: { label: { en: 'scores', zh: '分数' }, help: { en: 'One score per item, in the same order.', zh: '与候选一一对应、顺序相同的分数。' } },
      top: { label: { en: 'top', zh: '前 K 项' }, help: { en: 'The best few, best first.', zh: '得分最高的几条，按分数从高到低。' } },
      top_indices: { label: { en: 'top_indices', zh: '前 K 项序号' }, help: { en: 'Where they sat in the original list.', zh: '它们在原列表中的位置。' } },
    },
    params: { k: { label: { en: 'How many to keep', zh: '保留数量 K' }, help: { en: 'At least 1.', zh: '至少为 1。' } } },
  },
  'quality.score_table': {
    label: { en: 'Score Table', zh: '评分表' },
    help: { en: 'Shows every candidate against every metric, with the total and how far a failure fell short. Without it a threshold is a black box.', zh: '把每个候选在每项指标上的表现列出来，附总分与未通过时差多少分。没有它，阈值判定就是个黑箱。' },
    ports: {
      metrics: { label: { en: 'metrics', zh: '测量结果' }, help: { en: 'One measurement per candidate.', zh: '每个候选一份测量结果。' } },
      scores: { label: { en: 'scores', zh: '总分' }, help: { en: 'Optional. Adds the total and pass/fail columns.', zh: '选填，接入后增加总分与是否通过两列。' } },
      standard: { label: { en: 'standard', zh: '质量标准' }, help: { en: 'Optional. Supplies the pass mark shown in the table.', zh: '选填，提供表中显示的及格线。' } },
      table: { label: { en: 'table', zh: '表格' }, help: { en: 'The table, also shown in the run panel.', zh: '生成的表格，同时显示在运行面板中。' } },
    },
    params: {
      columns: { label: { en: 'Columns', zh: '指定列' }, help: { en: 'Optional list of metric names. Empty shows every numeric metric.', zh: '选填的指标名列表；留空则显示全部数值型指标。' } },
      pass_score: { label: { en: 'Pass mark', zh: '及格线' }, help: { en: 'Used when no standard is wired.', zh: '未接入质量标准时使用。' } },
    },
  },
  'quality.check_recipe': {
    label: { en: 'Show Recipe', zh: '查看配方' },
    help: {
      en: 'Reads the generation record a clip carries: which text, engine, reference and seed made it. A clip imported from disk has none, and says so.',
      zh: '读取音频自带的生成记录：由哪段文本、哪个引擎、哪条参考音频与哪个种子生成。从外部导入的音频没有配方，会明确报出。',
    },
    ports: {
      audio: { label: { en: 'audio', zh: '音频' }, help: { en: 'One clip or a list of them.', zh: '一条音频或一组音频。' } },
      recipe: { label: { en: 'recipe', zh: '配方' }, help: { en: 'The generation record, also shown in the run panel.', zh: '生成记录，同时显示在运行面板中。' } },
    },
    params: {},
  },

  // -- output ----------------------------------------------------------------
  'out.preview': {
    label: { en: 'Preview', zh: '预览 / 试听' },
    help: { en: 'Shows a value in the run panel — audio gets a player. Nothing is written to disk; that is the Save node\'s job.', zh: '在运行面板中展示某个值，音频会带播放器。不写入磁盘，写盘由「保存」节点负责。' },
    ports: { value: { label: { en: 'value', zh: '要看的值' }, help: { en: 'Anything: audio, text, metrics, a table.', zh: '任意值：音频、文本、测量结果、表格等。' } } },
    params: { label: { label: { en: 'Caption', zh: '标题' }, help: { en: 'Names this preview in the run panel.', zh: '在运行面板中为这条预览命名。' } } },
  },
  'out.save': {
    label: { en: 'Save to Disk', zh: '保存到磁盘' },
    help: { en: 'Writes values to files. Deliberately separate from Preview, so listening does not litter the disk.', zh: '把值写入文件。刻意与「预览」分开，避免试听产生大量垃圾文件。' },
    ports: {
      value: { label: { en: 'value', zh: '要保存的值' }, help: { en: 'One item or a list; a list becomes numbered files.', zh: '单个值或一组值；一组会写成带编号的多个文件。' } },
      saved: { label: { en: 'saved', zh: '已保存路径' }, help: { en: 'The paths actually written.', zh: '实际写入的文件路径。' } },
    },
    params: {
      dir: { label: { en: 'Folder', zh: '目标文件夹' }, help: { en: 'Empty uses the server\'s output folder.', zh: '留空则使用服务器的输出目录。' } },
      basename: { label: { en: 'File name', zh: '文件名' }, help: { en: 'Without the extension. Several items get _001, _002 …', zh: '不含扩展名；多个条目会加 _001、_002 等编号。' } },
    },
  },
  'out.save_voice': {
    label: { en: 'Save as Voice', zh: '保存为音色' },
    help: {
      en: 'Writes the settings from a recipe back into this machine\'s voice list, so a result worth keeping can be reused on the voices page and imported as a preset by later graphs. Connect it to the recipe output of Show Recipe.',
      zh: '把配方中的参数写回本机音色列表，使一次满意的结果可在音色页复用，也可被后续流程作为预设导入。请连接「查看配方」节点的配方输出。',
    },
    ports: {
      recipe: {
        label: { en: 'recipe', zh: '配方' },
        help: { en: 'The generation record to save. If several arrive, the first one is used.', zh: '要保存的生成记录；若传入多条，仅使用第 1 条。' },
      },
      voice_id: {
        label: { en: 'voice id', zh: '音色 ID' },
        help: { en: 'The id actually written, so later nodes can refer to it.', zh: '实际写入的音色 ID，可供后续节点引用。' },
      },
    },
    params: {
      voice_id: {
        label: { en: 'Voice id', zh: '音色 ID' },
        help: { en: 'Required. Letters, numbers, underscore and hyphen only — the same rule the voices page enforces.', zh: '必填。仅允许字母、数字、下划线与连字符，与音色页的规则一致。' },
      },
      display_name: {
        label: { en: 'Display name', zh: '显示名称' },
        help: { en: 'The name shown in voice lists. Empty uses the id.', zh: '音色列表中显示的名称；留空则使用音色 ID。' },
      },
      language: {
        label: { en: 'Language', zh: '语言' },
        help: { en: 'Language recorded on the voice. auto lets the server decide.', zh: '记录在音色上的语言；auto 表示由服务器判断。' },
      },
      overwrite: {
        label: { en: 'Overwrite an existing voice', zh: '覆盖同名音色' },
        help: { en: 'Off by default: an existing voice is not replaced silently, the run stops and says so.', zh: '默认关闭：不会静默覆盖已有音色，运行会中止并说明原因。' },
      },
    },
  },
  'sys.release': {
    label: { en: 'Release Memory', zh: '释放内存 / 显存' },
    help: {
      en: 'The explicit end of a line. Nothing is freed automatically, so a strand that is genuinely finished says so here — otherwise its values stay in memory on purpose.',
      zh: '一条支线的显式终点。系统不会自动释放，真正结束的支线要接到这里；否则其中的值会有意保留在内存中。',
    },
    ports: { value: { label: { en: 'value', zh: '要释放的值' }, help: { en: 'Everything upstream of these wires is released. Several wires are normal.', zh: '这些线上游的值都会被释放；接多条是常态。' } } },
    params: { release_vram: { label: { en: 'Also release VRAM', zh: '同时释放显存' }, help: { en: 'Asks the engine to unload from the GPU as well.', zh: '同时请求引擎从显卡上卸载模型。' } } },
  },
}

// -- lookup helpers ----------------------------------------------------------

function text(pair, fallback = '') {
  if (!pair) return { en: fallback, zh: fallback }
  if (typeof pair === 'string') return { en: pair, zh: pair }
  return { en: pair.en || pair.zh || fallback, zh: pair.zh || pair.en || fallback }
}

function nodeDoc(type) {
  return NODE_DOCS[type] || null
}

// `which` disambiguates the one case where an input and an output on the same
// node share a name (quality.threshold has both a `score` in and a `score` out);
// the documented key for the output is `score_out`.
function portDoc(type, portName, which = 'input') {
  const doc = NODE_DOCS[type]
  if (portName === 'enable') return ENABLE_PORT
  if (!doc || !doc.ports) return null
  if (which === 'output' && doc.ports[`${portName}_out`]) return doc.ports[`${portName}_out`]
  return doc.ports[portName] || null
}

function paramDoc(type, paramName) {
  const doc = NODE_DOCS[type]
  return (doc && doc.params && doc.params[paramName]) || null
}

function categoryDoc(id) {
  return CATEGORY_DOCS[id] || CATEGORY_DOCS.other
}

function portTypeDoc(portType) {
  return text(PORT_TYPE_DOCS[portType] || null, portType)
}

// 引擎参数格子的说明有两个来源：
//
//   1. 上面 NODE_DOCS['io.engine_params'].params 里手写的那几条（人话，保留）
//   2. 名片声明了、但没人手写过的键 —— 生成一句「平台不解释它」
//
// 两种都要补上「哪几台引擎认这个参数」。在装了不止一台引擎的机器上，
// 「这个格子对我选的引擎到底算不算数」是第一个要回答的问题 ——
// 填了一个对方不认的参数，跑起来会被 adapter.js 直接拦下。
const GENERIC_ENGINE_PARAM_DOC = Object.freeze({
  en: "Declared by the engine's own manifest. Aurivox forwards it untouched and does not interpret it — see that engine's documentation for what it does.",
  zh: '由引擎自己的名片声明。Aurivox 原样转发、不解释其含义 —— 具体作用请查阅该引擎自身的文档。',
})

function acceptedBySentence(acceptedLabels, installedCount) {
  if (acceptedLabels.length >= installedCount && installedCount > 0) {
    return {
      en: 'Every installed engine accepts it.',
      zh: '已安装的引擎都接受它。',
    }
  }
  return {
    en: `Only ${acceptedLabels.join(', ')} accepts it; filling it in while another engine is selected stops the run.`,
    zh: `仅 ${acceptedLabels.join('、')} 接受它；选用其他引擎时填了这一项，运行会被拦下。`,
  }
}

// 给一个引擎参数名凑出一份中英文均备的说明。
// nodeType 传进来是为了拿手写文案，不是为了判断引擎。
//
// 三个来源，优先级从高到低：
//   1. schemaEntry —— 名片自己写的 label/help。**引擎私有参数以它为准**，
//      因为参数是谁的，说明就该是谁写的（契约 C11）。
//   2. 平台手写 —— 现在只剩资产字段（模型权重 / 参考音频路径）。
//   3. GENERIC_ENGINE_PARAM_DOC —— 名片没写说明时的「平台不解释它」。
function engineParamDoc(nodeType, name, acceptedLabels, installedCount, schemaEntry = null) {
  const handwritten = paramDoc(nodeType, name)
  const fromSchema = schemaEntry && schemaEntry.help ? schemaEntry.help : null
  const base = fromSchema || (handwritten && handwritten.help ? handwritten.help : GENERIC_ENGINE_PARAM_DOC)
  const tail = acceptedBySentence(acceptedLabels, installedCount)
  // 中文句号后不加空格，英文句号后加 —— 拼出来的句子也要像人写的。
  const join = (headText, tailText) => {
    const head = String(headText || '').trim()
    if (!head) return tailText
    return /[。！？；）]$/.test(head) ? `${head}${tailText}` : `${head} ${tailText}`
  }
  return {
    label: (schemaEntry && schemaEntry.label) || (handwritten && handwritten.label) || { en: name, zh: name },
    help: {
      en: join(text(base, '').en, tail.en),
      zh: join(text(base, '').zh, tail.zh),
    },
  }
}

module.exports = {
  NODE_DOCS,
  CATEGORY_DOCS,
  PORT_TYPE_DOCS,
  ENABLE_PORT,
  text,
  nodeDoc,
  portDoc,
  paramDoc,
  categoryDoc,
  portTypeDoc,
  engineParamDoc,
  GENERIC_ENGINE_PARAM_DOC,
}
