#!/usr/bin/env node
// tools/migrate-asset-models.cjs
// ---------------------------------------------------------------------------
//  把角色的模型搬进按引擎分层的新位置
// ---------------------------------------------------------------------------
//
//  老：assets/<角色>/gpt_checkpoints/*.ckpt
//      assets/<角色>/sovits_models/*.pth
//  新：assets/<角色>/models/gpt-sovits/gpt/*.ckpt
//      assets/<角色>/models/gpt-sovits/sovits/*.pth
//
//  为什么要搬：老结构把 GPT-SoVITS 的两个目录名写死在角色目录的第一层，
//  于是第二台引擎的模型在磁盘上**没有位置可放**。新结构多的那两层
//  （引擎 id / 权重位名）不是装饰 —— 「哪些角色有这台引擎的模型」从此
//  只要看一眼目录名就能回答，不用问名片、不用猜后缀、不用读文件头。
//
// ── 怎么用 ──────────────────────────────────────────────────────────────
//
//    node tools\migrate-asset-models.cjs            先看它打算做什么（不动盘）
//    node tools\migrate-asset-models.cjs --apply    真的搬
//
//  ⭐ **默认空跑**。权重动辄好几 GB，而且是训练几个小时的产物 ——
//    一个默认就动手的工具不配碰它们。
//
// ── 规矩 ────────────────────────────────────────────────────────────────
//
//  · **移动，不复制**。复制会让盘上出现两份几 GB 的东西，
//    而且从此没人说得清哪一份是真的。
//  · **目标已存在就停**，绝不覆盖。同名不同内容的两份权重，
//    覆盖掉的那一份可能是几个小时的训练。
//  · **不删老目录**。搬空之后那个空壳留在原地，你自己确认没问题了再删。
//    ⛔ 工具替你删目录，是这类脚本最经典的一种伤害。
//  · 跨盘符也能搬：rename 失败（EXDEV）时退回「拷贝 + 校验大小 + 删源」。
//  · 可以重复跑：已经搬好的角色第二次跑就是「没什么可做的」。
//
// ⚠ 搬完之后 meta.json 里的模型清单会过时 —— 不用管，它是扫盘缓存不是真相
//   （lib/assetScanner.js 找不到就现场重扫）。下一次扫盘会自动对上。

const fs = require('fs');
const path = require('path');

const { ASSETS_ROOT } = require('../lib/paths');
const { slotDir, LEGACY_MODEL_DIRS } = require('../lib/assets/modelLayout');

// 老目录名 → 它其实是哪台引擎的哪个权重位。
//
// ⚠ 这张表是**一次性的历史知识**，写在搬家工具里正合适 —— 它记录的是
//   「2026-08-30 之前盘上长什么样」，而不是平台今后的规则。
//   ⛔ 别把它挪进 lib/：那等于把一台引擎的形状又请回平台里。
const MOVES = [
  { from: 'gpt_checkpoints', engine: 'gpt-sovits', slot: 'gpt' },
  { from: 'sovits_models', engine: 'gpt-sovits', slot: 'sovits' },
];

// 自检：这张表必须把 modelLayout 认得的老目录**全部**覆盖到。
// 漏一个 ⇒ 扫盘会一直报「还没搬」，而工具说没什么可做的 —— 死循环。
{
  const covered = new Set(MOVES.map(m => m.from));
  const missing = LEGACY_MODEL_DIRS.filter(d => !covered.has(d));
  if (missing.length) {
    console.error(`[migrate] 内部不一致：这些老目录没有搬家规则：${missing.join(', ')}`);
    process.exit(2);
  }
}

const APPLY = process.argv.includes('--apply');
const ROOT = ASSETS_ROOT;

function isNoise(name) {
  return name === 'Thumbs.db' || name === 'desktop.ini' || String(name).startsWith('.');
}

/** 移动一项。跨盘符时退回拷贝+校验+删源。返回 'moved' | 'skipped' | 'failed'。 */
function moveOne(src, dst, plan) {
  if (fs.existsSync(dst)) {
    plan.push(`  ⚠ 跳过（目标已存在，绝不覆盖）: ${dst}`);
    return 'skipped';
  }
  plan.push(`  → ${src}\n    ⇒ ${dst}`);
  if (!APPLY) return 'moved';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return 'moved';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // 跨盘符：拷完先核对大小，对得上才删源。⛔ 不校验就删是在拿权重赌 I/O。
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
      if (fs.statSync(dst).size !== st.size) {
        plan.push(`  ⛔ 拷贝后大小对不上，源文件保留不动: ${src}`);
        return 'failed';
      }
    }
    fs.rmSync(src, { recursive: true, force: true });
    return 'moved';
  }
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.log(`[migrate] 没有资产目录，无事可做：${ROOT}`);
    return;
  }
  console.log(`[migrate] 资产目录：${ROOT}`);
  console.log(APPLY
    ? '[migrate] --apply：**真的会动盘**。'
    : '[migrate] 空跑（默认）。确认没问题后加 --apply 才真的搬。');
  console.log('');

  let movedTotal = 0, skippedTotal = 0, failedTotal = 0, voicesTouched = 0;

  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory() || isNoise(ent.name)) continue;
    const voiceDir = path.join(ROOT, ent.name);
    const plan = [];
    let moved = 0, skipped = 0, failed = 0;

    for (const mv of MOVES) {
      const oldDir = path.join(voiceDir, mv.from);
      let items;
      try { items = fs.readdirSync(oldDir); } catch { continue; }
      items = items.filter(f => !isNoise(f));
      if (items.length === 0) continue;
      plan.push(`  ${mv.from}/ → models/${mv.engine}/${mv.slot}/  （${items.length} 项）`);
      for (const f of items) {
        const r = moveOne(path.join(oldDir, f), path.join(slotDir(voiceDir, mv.engine, mv.slot), f), plan);
        if (r === 'moved') moved++;
        else if (r === 'skipped') skipped++;
        else failed++;
      }
    }

    if (plan.length) {
      voicesTouched++;
      console.log(`[${ent.name}]`);
      for (const l of plan) console.log(l);
      console.log('');
    }
    movedTotal += moved; skippedTotal += skipped; failedTotal += failed;
  }

  console.log('─'.repeat(60));
  if (voicesTouched === 0) {
    console.log('[migrate] 没有需要搬的角色 —— 要么已经搬完了，要么本来就没有老结构。');
    return;
  }
  console.log(`[migrate] ${voicesTouched} 个角色，${APPLY ? '已搬' : '待搬'} ${movedTotal} 项`
    + `${skippedTotal ? `，跳过 ${skippedTotal} 项（目标已存在）` : ''}`
    + `${failedTotal ? `，失败 ${failedTotal} 项` : ''}`);
  if (!APPLY) {
    console.log('[migrate] 以上一个字节都没动。要真的搬：node tools/migrate-asset-models.cjs --apply');
  } else {
    console.log('[migrate] 老目录**没有删**（空壳留在原地）。你确认过再自己删。');
    console.log('[migrate] 下一次扫盘会自动更新 meta.json —— 那只是缓存，不用手动改。');
  }
  if (failedTotal) process.exitCode = 1;
}

main();
