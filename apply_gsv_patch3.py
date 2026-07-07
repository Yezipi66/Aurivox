#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply_gsv_patch3.py — 接通 v2Pro / v2ProPlus 训练 + 元数据记录底模版本

必须在 apply_gsv_patch.py(补丁1) 和 apply_gsv_patch2.py(补丁2) 之后运行。

本补丁做三件事（全部读取用户配置，无硬编码版本）：

  1) [preprocess.js]  预处理阶段按训练版本运行：
       - 计算 trainVersion = training.version（v2 / v2Pro / v2ProPlus，缺省 v2）；
       - 把 version 注入预处理脚本环境（1-get-text / 3-get-semantic 等）；
       - 当版本为 v2Pro / v2ProPlus 时，追加运行 2-get-sv.py 生成 7-sv_cn/
         （说话人向量 SV 特征）；该步失败不致命（数据集会回退零向量继续训练）；
       - meta.json 写入 base_version（训练目标版本）。

  2) [train.js]  S2(SoVITS) 训练按版本接通：
       - 底模按版本选择：v2 → s2G2333k(优先)/s2G488k；
         v2Pro → s2Gv2Pro；v2ProPlus → s2Gv2ProPlus（D 判别器同理）；
       - s2Config.model.version 写入实际训练版本（原来写死 'v2'）；
       - 把 7-sv_cn/ 复制到 S2 实验目录，供 v2Pro 数据集读取。

  3) [assetScanner.js]  资产扫描时读取每个 .pth 的 2 字节版本头，
       在 meta.assets.checkpoints.sovits[*] 上记录 version 字段
       （v1/v2/v3/v4/v2Pro/v2ProPlus）——与官方 process_ckpt 的判定一致。

前端只需在发起训练时传 training.version = 'v2Pro'（或 'v2ProPlus'）即可切换；
不传则保持 v2，行为与现在一致。

用法：
    python apply_gsv_patch3.py                # 自动探测项目根
    python apply_gsv_patch3.py --root D:\\Project\\tts_broker_openai_compat
    python apply_gsv_patch3.py --dry-run      # 只检查能否应用，不写文件
"""

import argparse
import io
import os
import sys
import time

# ----------------------------------------------------------------------------
# 通用工具
# ----------------------------------------------------------------------------
def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def backup(p):
    b = "%s.bak3.%d" % (p, int(time.time()))
    with io.open(p, "r", encoding="utf-8") as src, \
         io.open(b, "w", encoding="utf-8", newline="") as dst:
        dst.write(src.read())
    return b


def find_root(explicit):
    rel = os.path.join("lib", "training", "steps", "train.js")
    if explicit:
        if os.path.isfile(os.path.join(explicit, rel)):
            return os.path.abspath(explicit)
        print("✗ --root 下未找到 %s" % rel)
        sys.exit(2)
    here = os.path.dirname(os.path.abspath(__file__))
    cwd = os.path.abspath(os.getcwd())
    for base in (here, cwd):
        cur = base
        for _ in range(7):
            if os.path.isfile(os.path.join(cur, rel)):
                return cur
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
    print("✗ 未能自动定位项目根（含 lib/training/steps/train.js）。请用 --root 指定。")
    sys.exit(2)


class Patcher:
    """按有序的 (name, marker, old, new) 编辑列表对单个文件打补丁。

    marker 命中 => 视为已打过该补丁 => 跳过（幂等）。
    old 必须唯一出现一次，否则报错中止（避免误改）。
    """

    def __init__(self, path, dry):
        self.path = path
        self.dry = dry
        self.src = read(path)
        self.orig = self.src
        self.applied = []
        self.skipped = []

    def edit(self, name, marker, old, new):
        if marker in self.src:
            self.skipped.append(name)
            return
        cnt = self.src.count(old)
        if cnt == 0:
            raise RuntimeError(
                "在 %s 中找不到锚点用于【%s】。\n"
                "  多半是补丁1/补丁2 尚未应用，或该文件已被改动。\n"
                "  请先运行 apply_gsv_patch.py 和 apply_gsv_patch2.py。"
                % (os.path.basename(self.path), name))
        if cnt > 1:
            raise RuntimeError(
                "锚点在 %s 中出现 %d 次（应唯一），为安全起见中止：%s"
                % (os.path.basename(self.path), cnt, name))
        self.src = self.src.replace(old, new, 1)
        self.applied.append(name)

    def commit(self):
        if self.src == self.orig:
            return False
        if self.dry:
            return True
        backup(self.path)
        write(self.path, self.src)
        return True


# ============================================================================
# 1) preprocess.js
# ============================================================================
def patch_preprocess(path, dry):
    p = Patcher(path, dry)

    # --- 1a. 计算 trainVersion（版本归一化） ---
    p.edit(
        "计算 trainVersion（预处理）",
        "const trainVersion =",
        "  const { workDir, inputDir, voiceId, config } = ctx;\n"
        "  const trainCfg = config.training;",
        "  const { workDir, inputDir, voiceId, config } = ctx;\n"
        "  const trainCfg = config.training;\n"
        "  const trainVersion = (() => {\n"
        "    const s = String(trainCfg.version || trainCfg.model_version || trainCfg.sovits_version || '')\n"
        "      .toLowerCase().replace(/[\\s_-]/g, '');\n"
        "    if (s === 'v2proplus') return 'v2ProPlus';\n"
        "    if (s === 'v2pro') return 'v2Pro';\n"
        "    return 'v2';\n"
        "  })();",
    )

    # --- 1b. 把 version 注入预处理脚本公共环境 ---
    p.edit(
        "预处理环境注入 version",
        "      version: trainVersion,",
        "      lang: lang,\n"
        "    });",
        "      lang: lang,\n"
        "      version: trainVersion,\n"
        "    });",
    )

    # --- 1c. v2Pro/v2ProPlus 追加 2-get-sv.py 步骤（生成 7-sv_cn/） ---
    p.edit(
        "追加 2-get-sv.py（v2Pro SV 特征）",
        "2-get-sv.py",
        "    if (r3.status !== 0) {\n"
        "      throw new Error(`3-get-semantic.py failed with exit code ${r3.status}: ${r3.stderr.slice(-300)}`);\n"
        "    }\n"
        "  } else {",
        "    if (r3.status !== 0) {\n"
        "      throw new Error(`3-get-semantic.py failed with exit code ${r3.status}: ${r3.stderr.slice(-300)}`);\n"
        "    }\n"
        "\n"
        "    // Step 4（仅 v2Pro / v2ProPlus）: 2-get-sv.py 生成 7-sv_cn/（说话人向量 SV 特征）。\n"
        "    // ERes2NetV2 / kaldi 模块位于 lib/inference，需临时加入 PYTHONPATH。\n"
        "    // 该步失败不致命：数据集在缺 7-sv_cn 时回退零向量，训练仍可继续（仅无 SV 增益）。\n"
        "    if (trainVersion === 'v2Pro' || trainVersion === 'v2ProPlus') {\n"
        "      const svCkpt = path.join(gsvTools, 'pretrained', 'sv', 'pretrained_eres2netv2w24s4ep4.ckpt');\n"
        "      const inferenceDir = path.join(__dirname, '..', '..', 'inference');\n"
        "      if (!fs.existsSync(svCkpt)) {\n"
        "        log(`  ⚠ 未找到 SV 底模(${svCkpt})，跳过 2-get-sv.py；${trainVersion} 将退化为无 SV 特征训练。`);\n"
        "        log(`     可运行 download_models.py --set sv 下载。`);\n"
        "      } else {\n"
        "        log('  [4/4] 运行 2-get-sv.py (v2Pro SV 特征)...');\n"
        "        const r4 = await spawnAsync(python, [path.join(prepareDir, '2-get-sv.py')], {\n"
        "          cwd: gsvCode,\n"
        "          timeout: 600000,\n"
        "          env: {\n"
        "            ...commonEnv,\n"
        "            sv_path: svCkpt,\n"
        "            PYTHONPATH: [commonEnv.PYTHONPATH, inferenceDir].filter(Boolean).join(path.delimiter),\n"
        "          },\n"
        "          onChild: (proc) => ctx.setChild(proc),\n"
        "          onStdout: (s) => log(`[2-get-sv] ${s.trimEnd()}`),\n"
        "          onStderr: (s) => log(`[2-get-sv:err] ${s.trimEnd()}`),\n"
        "        });\n"
        "        if (r4.status !== 0) {\n"
        "          log(`  ⚠ 2-get-sv.py 失败(exit ${r4.status})，回退为无 SV 特征训练: ${(r4.stderr || '').slice(-200)}`);\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "  } else {",
    )

    # --- 1d. meta.json 记录 base_version ---
    p.edit(
        "meta.json 记录 base_version",
        "base_version: trainVersion,",
        "    created_at: new Date().toISOString(),\n"
        "    assets: {",
        "    created_at: new Date().toISOString(),\n"
        "    base_version: trainVersion,\n"
        "    assets: {",
    )

    changed = p.commit()
    return p, changed


# ============================================================================
# 2) train.js
# ============================================================================
def patch_trainjs(path, dry):
    p = Patcher(path, dry)

    # --- 2a. S2 底模按版本选择（替换补丁2 写入的 s2G2333k 候选块） ---
    old_block = (
        "  const pretrainedS2G = resolvePretrained('SoVITS 生成器(s2G)', [\n"
        "    path.join('gsv-v2final', 's2G2333k.pth'),\n"
        "    path.join('gsv-v2final-pretrained', 's2G2333k.pth'),\n"
        "    's2G2333k.pth',\n"
        "    path.join('v2Pro', 's2G488k.pth'),\n"
        "    's2G488k.pth',\n"
        "    path.join('gsv-v2final', 's2G488k.pth'),\n"
        "  ]);\n"
        "  const pretrainedS2D = resolvePretrained('SoVITS 判别器(s2D)', [\n"
        "    path.join('gsv-v2final', 's2D2333k.pth'),\n"
        "    path.join('gsv-v2final-pretrained', 's2D2333k.pth'),\n"
        "    's2D2333k.pth',\n"
        "    path.join('v2Pro', 's2D488k.pth'),\n"
        "    's2D488k.pth',\n"
        "    path.join('gsv-v2final', 's2D488k.pth'),\n"
        "  ]);"
    )
    new_block = (
        "  // 训练目标版本（读取用户配置；缺省 v2，行为与旧版一致）\n"
        "  const trainVersion = (() => {\n"
        "    const s = String(trainCfg.version || trainCfg.model_version || trainCfg.sovits_version || '')\n"
        "      .toLowerCase().replace(/[\\s_-]/g, '');\n"
        "    if (s === 'v2proplus') return 'v2ProPlus';\n"
        "    if (s === 'v2pro') return 'v2Pro';\n"
        "    return 'v2';\n"
        "  })();\n"
        "  log(`S2 目标版本: ${trainVersion}`);\n"
        "\n"
        "  // 底模按版本选择：v2 优先真正的 v2 底模 s2G2333k（回退 s2G488k 走 shape-safe）；\n"
        "  // v2Pro / v2ProPlus 用各自的 Pro 底模。\n"
        "  const _S2G_CANDS = {\n"
        "    v2: ['gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth',\n"
        "         'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'],\n"
        "    v2Pro: ['v2Pro/s2Gv2Pro.pth'],\n"
        "    v2ProPlus: ['v2Pro/s2Gv2ProPlus.pth'],\n"
        "  };\n"
        "  const _S2D_CANDS = {\n"
        "    v2: ['gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth',\n"
        "         'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'],\n"
        "    v2Pro: ['v2Pro/s2Dv2Pro.pth'],\n"
        "    v2ProPlus: ['v2Pro/s2Dv2ProPlus.pth'],\n"
        "  };\n"
        "  const pretrainedS2G = resolvePretrained('SoVITS 生成器(s2G/' + trainVersion + ')', _S2G_CANDS[trainVersion]);\n"
        "  const pretrainedS2D = resolvePretrained('SoVITS 判别器(s2D/' + trainVersion + ')', _S2D_CANDS[trainVersion]);"
    )
    p.edit("S2 底模按版本选择", "_S2G_CANDS", old_block, new_block)

    # --- 2b. s2Config.model.version 写入实际版本 ---
    p.edit(
        "s2Config.model.version 按版本写入",
        "s2Config.model.version = trainVersion;",
        "  s2Config.model.version = s2Config.model.version || 'v2';",
        "  s2Config.model.version = trainVersion;",
    )

    # --- 2c. 从 inputDir 兜底复制 7-sv_cn 到 workDir ---
    p.edit(
        "copyData 7-sv_cn",
        "copyData('7-sv_cn');",
        "  copyData('6-name2semantic-0.tsv');",
        "  copyData('6-name2semantic-0.tsv');\n"
        "  copyData('7-sv_cn');",
    )

    # --- 2d. 复制 7-sv_cn 到 S2 实验目录（v2Pro 数据集读取路径） ---
    p.edit(
        "复制 7-sv_cn 到 S2 实验目录",
        "复制 7-sv_cn 到 S2 实验目录",
        "  // 准备 S2 配置 — 写入临时文件，避免并发冲突",
        "  // v2Pro / v2ProPlus: 复制 SV 特征目录到实验目录（缺失则数据集回退零向量）\n"
        "  {\n"
        "    const svSrc = path.join(workDir, '7-sv_cn');\n"
        "    const svDst = path.join(s2ExpDir, '7-sv_cn');\n"
        "    if (fs.existsSync(svSrc) && !fs.existsSync(svDst)) {\n"
        "      fs.mkdirSync(svDst, { recursive: true });\n"
        "      for (const f of fs.readdirSync(svSrc)) {\n"
        "        fs.copyFileSync(path.join(svSrc, f), path.join(svDst, f));\n"
        "      }\n"
        "      log('  复制 7-sv_cn 到 S2 实验目录');\n"
        "    }\n"
        "  }\n"
        "\n"
        "  // 准备 S2 配置 — 写入临时文件，避免并发冲突",
    )

    changed = p.commit()
    return p, changed


# ============================================================================
# 3) assetScanner.js
# ============================================================================
def patch_assetscanner(path, dry):
    p = Patcher(path, dry)

    old_block = (
        "  // --- sovits_models/ ---\n"
        "  const sovitsDir = path.join(voiceDir, \"sovits_models\");\n"
        "  if (fs.existsSync(sovitsDir)) {\n"
        "    const files = fs.readdirSync(sovitsDir).filter(f => /\\.pth$/i.test(f));\n"
        "    meta.assets.checkpoints = meta.assets.checkpoints || {};\n"
        "    meta.assets.checkpoints.sovits = files.map(f => {\n"
        "      const stat = fs.statSync(path.join(sovitsDir, f));\n"
        "      return {\n"
        "        name: f,\n"
        "        path: path.join(sovitsDir, f).replace(/\\\\/g, \"/\"),\n"
        "        size_mb: Math.round(stat.size / (1024 * 1024)),\n"
        "      };\n"
        "    });\n"
        "  }"
    )
    new_block = (
        "  // --- sovits_models/ ---\n"
        "  const sovitsDir = path.join(voiceDir, \"sovits_models\");\n"
        "  if (fs.existsSync(sovitsDir)) {\n"
        "    // 读取 .pth 前 2 字节版本头判断底模版本（与官方 process_ckpt 判定一致）。\n"
        "    const detectSovitsVersion = (fp) => {\n"
        "      try {\n"
        "        const fd = fs.openSync(fp, \"r\");\n"
        "        const buf = Buffer.alloc(2);\n"
        "        fs.readSync(fd, buf, 0, 2, 0);\n"
        "        fs.closeSync(fd);\n"
        "        const head = buf.toString(\"latin1\");\n"
        "        const map = { \"00\": \"v1\", \"01\": \"v2\", \"02\": \"v3\", \"03\": \"v3\", \"04\": \"v4\", \"05\": \"v2Pro\", \"06\": \"v2ProPlus\" };\n"
        "        if (Object.prototype.hasOwnProperty.call(map, head)) return map[head];\n"
        "        // 传统 torch.save（zip，头为 'PK'）：按文件大小粗判\n"
        "        const sz = fs.statSync(fp).size;\n"
        "        if (sz < 82978 * 1024) return \"v1\";\n"
        "        if (sz < 700 * 1024 * 1024) return \"v2\";\n"
        "        return \"v3\";\n"
        "      } catch (e) { return null; }\n"
        "    };\n"
        "    const files = fs.readdirSync(sovitsDir).filter(f => /\\.pth$/i.test(f));\n"
        "    meta.assets.checkpoints = meta.assets.checkpoints || {};\n"
        "    meta.assets.checkpoints.sovits = files.map(f => {\n"
        "      const stat = fs.statSync(path.join(sovitsDir, f));\n"
        "      return {\n"
        "        name: f,\n"
        "        path: path.join(sovitsDir, f).replace(/\\\\/g, \"/\"),\n"
        "        size_mb: Math.round(stat.size / (1024 * 1024)),\n"
        "        version: detectSovitsVersion(path.join(sovitsDir, f)),\n"
        "      };\n"
        "    });\n"
        "  }"
    )
    p.edit("sovits 元数据记录 version", "detectSovitsVersion", old_block, new_block)

    changed = p.commit()
    return p, changed


# ============================================================================
# 主流程
# ============================================================================
def main():
    ap = argparse.ArgumentParser(description="接通 v2Pro/v2ProPlus 训练 + 元数据底模版本")
    ap.add_argument("--root", default=None, help="项目根目录（默认自动探测）")
    ap.add_argument("--dry-run", action="store_true", help="只检查能否应用，不写文件")
    args = ap.parse_args()

    root = find_root(args.root)
    print("=" * 64)
    print("补丁3：接通 v2Pro / v2ProPlus 训练 + 元数据记录底模版本")
    print("  项目根: %s" % root)
    if args.dry_run:
        print("  模式: DRY-RUN（不写文件）")
    print("=" * 64)

    targets = [
        (os.path.join(root, "lib", "training", "steps", "preprocess.js"), patch_preprocess),
        (os.path.join(root, "lib", "training", "steps", "train.js"), patch_trainjs),
        (os.path.join(root, "lib", "assetScanner.js"), patch_assetscanner),
    ]

    total_applied = 0
    any_error = False
    for fpath, fn in targets:
        rel = os.path.relpath(fpath, root)
        if not os.path.isfile(fpath):
            print("\n[%s]  ✗ 文件不存在，跳过" % rel)
            any_error = True
            continue
        try:
            p, changed = fn(fpath, args.dry_run)
        except RuntimeError as e:
            print("\n[%s]  ✗ %s" % (rel, e))
            any_error = True
            continue
        print("\n[%s]" % rel)
        for n in p.applied:
            print("   ✓ 应用: %s" % n)
        for n in p.skipped:
            print("   • 已存在，跳过: %s" % n)
        if changed and not args.dry_run:
            print("   已写回（原文件已备份为 *.bak3.*）")
        total_applied += len(p.applied)

    print("\n" + "=" * 64)
    if any_error:
        print("⚠ 有文件未能完整打补丁，请看上面的错误。")
        print("  常见原因：未先运行 补丁1 + 补丁2；或文件已被手工改动。")
    if total_applied == 0 and not any_error:
        print("✓ 全部补丁此前已应用（幂等，无需改动）。")
    elif not any_error:
        print("✓ 补丁3 应用完成，共 %d 处改动。" % total_applied)
        print("\n下一步：")
        print("  1) 用 download_models.py 下载对应底模：")
        print("       python download_models.py --set v2         # 修复 v2 质量")
        print("       python download_models.py --set v2proplus  # v2ProPlus(含 SV)")
        print("  2) 前端发起训练时传 training.version = 'v2Pro' 或 'v2ProPlus'。")
        print("  3) 先训练一个角色验证出人声，再全面切换。")
    print("=" * 64)
    return 1 if any_error else 0


if __name__ == "__main__":
    sys.exit(main())
