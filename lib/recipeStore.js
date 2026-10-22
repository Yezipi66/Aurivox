// 配方（recipe）存储层：一条配方是绑定到角色的可复用推理预设，一份配方一个 JSON 文件。
// id 是 {角色}/{名字}，也就是 OpenAI 的 voice 字段。
// 边界：纯存储层，不认识任何一台引擎。参数的类型与默认值问名片（契约 C11），
// 哪台引擎可用、路径能否指向项目外，都由调用层判定。

const fs = require("fs");
const path = require("path");
const { engineUiSchema } = require("./engines/paramTable");

// schema_version 4：配方成为闭合的调用目标，除 text 外什么都不缺，包括去哪台引擎。
// engine_params 按引擎 id 分格，原样存原样取。
// 存量配方更新时保留自己的 schema_version，不会被悄悄改成 4；只有新建才写 4。
const SCHEMA_VERSION = 4;
const MAX_NAME_LEN = 64;

// 平台通用格子的键：speed 与 seed。这两个键不属于任何一台引擎，是平台自己要用的，
// 所以留在 params 里而不进 engine_params。
const GENERIC_PARAM_KEYS = new Set(["speed", "seed"]);

// v3 时代的通用键白名单：v4 继续收下这些键，只是不再把表外的键丢掉。
// 书写顺序也是 params 的键序，不能改。
const V3_PARAM_KEYS = new Set([
  "top_k", "top_p", "temperature", "speed",
  "text_split_method", "repetition_penalty", "sample_steps", "if_sr",
  "batch_size", "batch_threshold", "split_bucket", "fragment_interval",
  "parallel_infer", "seed", "aux_ref_audio_paths", "pron_overrides",
]);

// 文件名里不安全的符号，会破坏 {角色}/{名字} 的 voice 语法。Unicode 字母允许。
const NAME_BLACKLIST = /[\/\\:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// 校验角色名（OpenAI 的 voice 字段里那一段）。合法形态是 [a-zA-Z0-9_-]+。
// @returns {{ok:true} | {ok:false, error:string}}
function validateVoiceId(role) {
  if (typeof role !== "string" || !role.trim()) {
    return { ok: false, error: "role (voiceId) is required" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(role)) {
    return { ok: false, error: "role must match [a-zA-Z0-9_-]+" };
  }
  return { ok: true };
}

// 校验配方名字（同一角色下的那一段）。超过 64 字符、含控制字符、
// 含会破坏 {角色}/{名字} 语法的文件系统符号、以点开头，都不合法。
// @returns {{ok:true, value:string} | {ok:false, error:string}} value 是去掉首尾空白后的名字
function validateName(name) {
  if (typeof name !== "string") {
    return { ok: false, error: "name is required" };
  }
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "name is required" };
  if (trimmed.length > MAX_NAME_LEN) {
    return { ok: false, error: `name too long (max ${MAX_NAME_LEN})` };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: "name contains control characters" };
  }
  if (NAME_BLACKLIST.test(trimmed)) {
    return { ok: false, error: 'name must not contain / \\ : * ? " < > |' };
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return { ok: false, error: "name must not start with '.'" };
  }
  return { ok: true, value: trimmed };
}

function displayNameFor(role, name) {
  return `${role.toUpperCase()} - ${name}`;
}

function recipeFilename(role, name) {
  return `recipe_${role}_${name}.json`;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// 只有项目相对路径能存进配方（可移植、分发安全）：绝对路径、盘符与 .. 穿越都拒绝。
function isProjectRelativePath(p) {
  return typeof p === "string" && p !== "" &&
    !p.includes("..") && !p.startsWith("/") && !p.includes(":\\") && !p.includes(":/");
}

// v3 结构化托管路径对象：{ base: "asset"|"external", path: "..." }。
function isManagedPathObject(v) {
  return isPlainObject(v) &&
    (v.base === "asset" || v.base === "external") &&
    typeof v.path === "string" && v.path !== "";
}

// portable 是推导出来的（asset 为真，external 为假）：可以落盘，但不许与 base 矛盾。
function portableInconsistent(v) {
  return isManagedPathObject(v) && v.portable !== undefined &&
    !!v.portable !== (v.base === "asset");
}

// 校验一个托管路径字段的值。收 "" 与 null（表示清空），收结构化对象（形状在这里校验，
// 字段级的外部路径放行由服务层的 pathResolver 管），也收裸字符串：可移植字段的裸字符串
// 必须是项目相对路径；模型字段历史上存过绝对路径，照原样收。
function managedFieldError(v, { field, portableString }) {
  if (v === "" || v == null) return null;
  if (isManagedPathObject(v)) {
    if (portableInconsistent(v)) return `${field}.portable is inconsistent with base`;
    return null;
  }
  if (isPlainObject(v)) return `${field} object must be { base: "asset"|"external", path }`;
  if (typeof v === "string") {
    if (portableString && !isProjectRelativePath(v)) {
      return `${field} must be a project-relative path`;
    }
    return null;
  }
  return `${field} must be a string path or a { base, path } object`;
}

function num(v, d) {
  return v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;
}

function bool(v, d) {
  return v != null ? !!v : d;
}

// 平台通用格子的默认值。引擎参数的默认值一律写在名片里（契约 C11）。
// seed 的 -1 表示随机，由 resolveSeed 换成具体数字写进 meta.json，供 Rerun 复现。
const PLATFORM_GENERIC_DEFAULTS = { speed: 1.0, seed: -1 };

// 这台引擎的 { 参数名: type }。
// 类型表由调用方按配方自己那台引擎取：拿另一台的 schema 来 coerce，会在两台名片对同一个键
// 写了不同 type 的那天悄悄改值。engineId 为空或名片读不出来都返回空表：
// 存一条配方不该因为某台引擎现在装得不对而失败。
function paramTypesOf(engineId) {
  if (!engineId) return {};
  const out = {};
  try {
    for (const entry of engineUiSchema(engineId)) out[entry.name] = entry.type;
  } catch (_) { /* 名片读不出来：空表 */ }
  return out;
}

/**
 * 按名片声明的类型把一个值转成能存盘的形状。
 *
 * 这里不认识任何一个具体参数名：它只认名片上写的 type（契约 §5.5：平台只搬运，不翻译）。
 * 名片没描述过的键（平台通用格子 speed/seed）走数字，这是它们在平台侧的既有形状。
 * @param {string} key 参数名
 * @param {*} raw 要存的值
 * @param {object} types { 参数名: type }，来自这条配方自己那台引擎的名片。
 *   配方没记引擎则为空对象，除平台通用格子外原样存。
 * @returns {*} 存盘形状；返回 undefined 表示「这个键不该被写下来」。
 */
function coerceLegacyParam(key, raw, types) {
  // 只有平台自己的两个通用格子（speed / seed）有默认值。其余的键没有默认值：
  // raw 是空就是空，返回 undefined，上面那个循环会把这个键整个跳过。
  const isPlatformKey = Object.prototype.hasOwnProperty.call(PLATFORM_GENERIC_DEFAULTS, key);
  const def = isPlatformKey ? PLATFORM_GENERIC_DEFAULTS[key] : undefined;
  if (raw == null && !isPlatformKey) return undefined;
  const type = (isPlainObject(types) ? types : {})[key];
  if (type === "boolean") return bool(raw, def);
  // enum / select / path / file / string / text 存的是值本身，不是数。
  // 这些名字都要认：名片改名是渐进的，而一个 file 参数被 num() 一过就会变成 NaN 再变成默认值，
  // 症状是「我明明选了它，存完就没了」。
  if (type === "enum" || type === "select") return raw || def;
  if (type === "path" || type === "file") return raw || def;
  if (type === "string" || type === "text") return raw != null ? raw : def;
  if (type === "number" || type === "integer" || type === "float" || type === "int") {
    return num(raw, def);
  }
  if (isPlatformKey) return num(raw, def);
  // 剩下的：名片没说过这个键是什么类型（配方没记引擎，或那台引擎的 schema 里没有它），
  // 原样存。不 num()：拿一个不知道类型的值去过 num()，字符串会变成 NaN 再变成默认值，
  // 症状是「我明明填了，存完就没了」，而且不报错。
  return raw;
}

function createRecipeStore(recipesDir) {
  if (!recipesDir) throw new Error("recipesDir is required");

  function ensureDir() {
    fs.mkdirSync(recipesDir, { recursive: true });
  }

  // 先按 id 拼出确定路径；没有再按存下来的 id 扫目录，撞车与大小写都不怕。
  function pathFor(role, name) {
    return path.join(recipesDir, recipeFilename(role, name));
  }

  // 扫目录找 id 匹配的那一份，目录读不到返回 null。
  function findFileById(id) {
    let files = [];
    try { files = fs.readdirSync(recipesDir); } catch (_) { return null; }
    for (const f of files) {
      if (!f.startsWith("recipe_") || !f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(recipesDir, f), "utf-8"));
        if (data && data.id === id) return { file: path.join(recipesDir, f), data };
      } catch (_) { /* skip corrupt */ }
    }
    return null;
  }

  function readByRoleName(role, name) {
    const direct = pathFor(role, name);
    if (fs.existsSync(direct)) {
      try { return { file: direct, data: JSON.parse(fs.readFileSync(direct, "utf-8")) }; }
      catch (_) { /* fall through to scan */ }
    }
    return findFileById(`${role}/${name}`);
  }

  // 先写临时文件再改名：中途崩了也不会留下半份 JSON。
  function atomicWrite(file, obj) {
    ensureDir();
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }

  // 把客户端给的内容规整成一份配方，不落盘。
  // payload 里 role 或 voiceId 给出角色、name 给出名字、params 是通用格子、
  // engine_params 是每台引擎自己的格子；existing 是更新时的旧配方，缺省字段从它继承。
  // @returns {{ok:true, value:object} | {ok:false, error:string}}
  function normalize(payload, existing) {
    const role = payload.role != null ? payload.role : payload.voiceId;
    const rv = validateVoiceId(role);
    if (!rv.ok) return { ok: false, error: rv.error };

    const nv = validateName(payload.name);
    if (!nv.ok) return { ok: false, error: nv.error };
    const name = nv.value;

    // 参考音频：可以是旧写法的项目相对裸字符串，也可以是 v3 的 { base, path } 对象。
    // 裸字符串仍受项目相对约束，好让 "X:/..." 这种前向斜杠盘符写法钻不成静默的绝对路径；
    // 外部音频必须写成显式对象，由服务层的 allow_external_audio 把门。
    {
      const e = managedFieldError(payload.reference_audio, { field: "reference_audio", portableString: true });
      if (e) return { ok: false, error: e };
    }

    const srcParams = isPlainObject(payload.params) ? payload.params : {};
    const prevParams = existing && isPlainObject(existing.params) ? existing.params : {};

    // 辅助参考音频：项目相对路径的数组，任何不可移植的路径都拒绝。
    let auxRaw = srcParams.aux_ref_audio_paths;
    if (auxRaw === undefined) auxRaw = prevParams.aux_ref_audio_paths;
    let aux_ref_audio_paths = [];
    if (Array.isArray(auxRaw)) {
      for (const p of auxRaw) {
        if (p === "" || p == null) continue;
        if (typeof p === "string" || isPlainObject(p)) {
          const e = managedFieldError(p, { field: "aux_ref_audio_paths", portableString: true });
          if (e) return { ok: false, error: e };
          aux_ref_audio_paths.push(p);
        }
      }
    }

    // 发音覆盖：不透明字典，原样钉住。引擎的 set_context 吃什么形状就吃什么形状。
    let pron_overrides = srcParams.pron_overrides;
    if (pron_overrides === undefined) pron_overrides = prevParams.pron_overrides;
    if (!isPlainObject(pron_overrides)) pron_overrides = {};

    // 去哪台引擎：必须先解析，params 的类型表要问它要。
    // 空字符串仍然合法，含义是「这条配方没说去哪台」，调用层见到空就当场报 RECIPE_NO_ENGINE，
    // 没人替它挑一台。
    let engine_id = payload.engine_id != null ? payload.engine_id
      : (existing && existing.engine_id != null ? existing.engine_id : "");
    if (typeof engine_id !== "string") return { ok: false, error: "engine_id must be a string" };
    engine_id = engine_id.trim();
    if (engine_id && !/^[a-zA-Z0-9_.-]+$/.test(engine_id)) {
      return { ok: false, error: "engine_id must match [a-zA-Z0-9_.-]+" };
    }

    // 键集来自 V3_PARAM_KEYS，类型问这条配方自己那台引擎的名片，默认值一个都不填。
    // V3_PARAM_KEYS 的书写顺序即键序，迭代出来的顺序必须保持不变。
    // 没给值的键不落盘（coerceLegacyParam 返回 undefined），所以存量配方重存一次会掉键，
    // 掉的那些键本来就是从名片拷进来的默认值。
    const paramTypes = paramTypesOf(engine_id);
    const params = {};
    for (const key of V3_PARAM_KEYS) {
      // 这两个是结构化字段（数组 / 不透明字典），上面已经各自校验过了。
      if (key === "aux_ref_audio_paths" || key === "pron_overrides") continue;
      const raw = srcParams[key] != null ? srcParams[key] : prevParams[key];
      const v = coerceLegacyParam(key, raw, paramTypes);
      if (v !== undefined) params[key] = v;
    }
    params.aux_ref_audio_paths = aux_ref_audio_paths;
    params.pron_overrides = pron_overrides;

    // 模型权重字段：裸字符串（任意形式，含旧写法的绝对路径）或 v3 对象都收。
    // 裸字符串不受项目相对约束，安全由服务层的字段级放行与读取时的包含检查负责。
    {
      const eg = managedFieldError(payload.gpt_ckpt, { field: "gpt_ckpt", portableString: false });
      if (eg) return { ok: false, error: eg };
      const es = managedFieldError(payload.sovits_pth, { field: "sovits_pth", portableString: false });
      if (es) return { ok: false, error: es };
    }

    // 每台引擎自己的参数格子：原样存。不校验键名、不校验值、不填默认值、不排序、不裁剪。
    // 只校验一件事：它得是 { 引擎id: {对象} } 这个形状。形状错了，调用层就没法按
    // engine_params[engine_id] 取到格子，那才会静默失败。
    const srcBoxes = isPlainObject(payload.engine_params) ? payload.engine_params : null;
    const prevBoxes = existing && isPlainObject(existing.engine_params) ? existing.engine_params : {};
    const engine_params = {};
    for (const [k, v] of Object.entries(srcBoxes || prevBoxes)) {
      if (!isPlainObject(v)) {
        return { ok: false, error: `engine_params.${k} must be an object of that engine's own parameters` };
      }
      engine_params[k] = v;
    }

    // 白名单外的键不许被丢掉：它们直接消失还照返 200，保存成功了值没了。
    // 现在它们落进本次配方所属引擎的格子。只在 payload 显式带了 params 时才收，
    // 免得更新别的字段时把旧数据里的未知键重复搬一次。
    if (isPlainObject(payload.params)) {
      const strays = {};
      for (const [k, v] of Object.entries(payload.params)) {
        if (!V3_PARAM_KEYS.has(k)) strays[k] = v;
      }
      if (Object.keys(strays).length > 0) {
        const boxKey = engine_id || "";
        // 引擎未知（老配方、老前端）时用占位键收着，不丢掉。占位键本身可见可审计，
        // 比「值消失了」好得多。
        const target = boxKey || "_unassigned";
        engine_params[target] = Object.assign({}, engine_params[target], strays);
      }
    }

    const now = new Date().toISOString();
    const srcMeta = isPlainObject(payload.meta) ? payload.meta : {};
    const prevMeta = existing && isPlainObject(existing.meta) ? existing.meta : {};

    // 更新时保留原有的 schema_version，老配方不会被悄悄升级。新配方才写当前的
    // SCHEMA_VERSION，迁移要显式传 payload.schema_version。
    const schemaVersion =
      payload.schema_version != null ? payload.schema_version :
      (existing && existing.schema_version != null ? existing.schema_version : SCHEMA_VERSION);

    return {
      ok: true,
      value: {
        schema_version: schemaVersion,
        id: `${role}/${name}`,
        role,
        name,
        display_name: displayNameFor(role, name),

        reference_audio: payload.reference_audio || "",
        reference_text: payload.reference_text || "",
        // language 是配方可选钉住的目标文本语言：可以是具体语言、可以是自动模式、也可以留空。
        // 留空表示不钉死，回放时合成层跟素材的语言走。
        language: (typeof payload.language === "string" && payload.language.trim())
          ? payload.language.trim()
          : (existing && typeof existing.language === "string" ? existing.language : ""),

        engine_id,

        params,

        engine_params,

        // 钉住的模型权重，文件丢了由 Broker 页重新绑定。
        gpt_ckpt: payload.gpt_ckpt || (existing && existing.gpt_ckpt) || "",
        sovits_pth: payload.sovits_pth || (existing && existing.sovits_pth) || "",

        // 当前引擎的情绪控制（参考音频那条路）。
        emotion_ref: payload.emotion_ref || null,
        // 八维情绪向量。存盘层只搬运，读它的引擎不认这个字段时它就只是多带一个键。
        emo_vector: payload.emo_vector != null ? payload.emo_vector : null,

        meta: {
          source: srcMeta.source || prevMeta.source || "generate",
          created_at: prevMeta.created_at || now,
          updated_at: now,
          sovits_version: srcMeta.sovits_version || prevMeta.sovits_version || "",
          notes: srcMeta.notes != null ? srcMeta.notes : (prevMeta.notes || ""),
          tags: Array.isArray(srcMeta.tags) ? srcMeta.tags : (prevMeta.tags || []),
        },
      },
    };
  }

  return {
    SCHEMA_VERSION,
    validateVoiceId,
    validateName,
    normalize,

    // 新建一条配方。opts.force=true 时允许覆盖同名配方。
    // @returns {{ok:true, recipe:object} | {ok:false, code:'invalid'|'exists', error:string}}
    create(payload, opts) {
      const force = !!(opts && opts.force);
      const n = normalize(payload);
      if (!n.ok) return { ok: false, code: "invalid", error: n.error };
      const existing = readByRoleName(n.value.role, n.value.name);
      if (existing && !force) {
        return { ok: false, code: "exists", error: `recipe already exists: ${n.value.id}` };
      }
      // 强制覆盖时保留 created_at。
      if (existing) {
        const re = normalize(payload, existing.data);
        atomicWrite(existing.file, re.value);
        return { ok: true, recipe: re.value };
      }
      atomicWrite(pathFor(n.value.role, n.value.name), n.value);
      return { ok: true, recipe: n.value };
    },

    // 列出全部配方，按 id 排序。opts.role 给了就只返回该角色的。
    // @returns {object[]} 目录读不到时是空数组
    list(opts) {
      const role = opts && opts.role;
      let files = [];
      try { files = fs.readdirSync(recipesDir); } catch (_) { return []; }
      const out = [];
      for (const f of files) {
        if (!f.startsWith("recipe_") || !f.endsWith(".json")) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(recipesDir, f), "utf-8"));
          if (role && data.role !== role) continue;
          out.push(data);
        } catch (_) { /* skip corrupt */ }
      }
      out.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
      return out;
    },

    // 按角色加名字取一条。
    // @returns {object|null} 名字或角色不合法、盘上没有这一条时是 null
    get(role, name) {
      const rv = validateVoiceId(role); if (!rv.ok) return null;
      const nv = validateName(name); if (!nv.ok) return null;
      const found = readByRoleName(role, nv.value);
      return found ? found.data : null;
    },

    // 把 OpenAI 的 voice 字段（"角色/名字"）解析成配方。
    // @returns {object|null} 字段形状不对或解析不出时是 null
    resolveVoice(voiceField) {
      if (typeof voiceField !== "string") return null;
      const idx = voiceField.indexOf("/");
      if (idx <= 0 || idx === voiceField.length - 1) return null;
      const role = voiceField.slice(0, idx);
      const name = voiceField.slice(idx + 1);
      return this.get(role, name);
    },

    // 更新：合并一段局部改动（Broker 重新绑定模型与界面编辑都走这里）。
    // patch.params 与 patch.meta 是逐键合并，其余字段整段替换。
    // @returns {{ok:true, recipe:object} | {ok:false, code:'invalid'|'not_found', error:string}}
    update(role, name, patch) {
      const rv = validateVoiceId(role); if (!rv.ok) return { ok: false, code: "invalid", error: rv.error };
      const nv = validateName(name); if (!nv.ok) return { ok: false, code: "invalid", error: nv.error };
      const found = readByRoleName(role, nv.value);
      if (!found) return { ok: false, code: "not_found", error: `recipe not found: ${role}/${nv.value}` };

      const merged = Object.assign({}, found.data, isPlainObject(patch) ? patch : {});
      // role 与 name 不能通过 update 改（改名等于删了再建）。
      merged.role = found.data.role;
      merged.name = found.data.name;
      if (isPlainObject(patch) && isPlainObject(patch.params)) {
        merged.params = Object.assign({}, found.data.params, patch.params);
      }
      if (isPlainObject(patch) && isPlainObject(patch.meta)) {
        merged.meta = Object.assign({}, found.data.meta, patch.meta);
      }
      const n = normalize(merged, found.data);
      if (!n.ok) return { ok: false, code: "invalid", error: n.error };
      atomicWrite(found.file, n.value);
      return { ok: true, recipe: n.value };
    },

    // 删除一条配方。@returns {boolean} 文件确实删掉了才返回 true
    remove(role, name) {
      const rv = validateVoiceId(role); if (!rv.ok) return false;
      const nv = validateName(name); if (!nv.ok) return false;
      const found = readByRoleName(role, nv.value);
      if (!found) return false;
      try { fs.unlinkSync(found.file); return true; } catch (_) { return false; }
    },
  };
}

module.exports = { createRecipeStore, SCHEMA_VERSION, validateName, validateVoiceId };
